import {
    Exec,
    Func,
    isDefined,
    isUndefined,
    MutableObservableOption,
    Nullable,
    Option,
    Optional,
    Provider,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {dbToGain} from "@opendaw/lib-dsp"
import type {Project} from "../../project"
import {AudioContexts} from "../../AudioContexts"
import {AudioDevices} from "../../AudioDevices"
import {RecordingWorklet} from "../../RecordingWorklet"
import {AudioInputNodes, AudioInputPort, AudioInputRequest} from "../AudioInputPort"
import {RecordingLatency} from "../RecordingLatency"
import {RecordingSink} from "../RecordingSink"
import {BrowserMonitor} from "./BrowserMonitor"
import {BrowserRecordingLatency} from "./BrowserRecordingLatency"

// Ring capacity in render-quantum chunks (~3s at 48kHz). The reader worker keeps the ring drained in real time;
// the headroom only needs to cover the worker's async boot and transient stalls. See issue #290.
const RecordingRingChunks = 1024

type AudioChain = {
    sourceNode: MediaStreamAudioSourceNode
    recordGainNode: GainNode
    monitorMixdown: GainNode
    keepAliveSink: GainNode
    channelCount: 1 | 2
}

export class BrowserAudioInput implements AudioInputPort, AudioInputNodes {
    readonly #project: Project
    readonly #request: Provider<Option<AudioInputRequest>>
    readonly #stream: MutableObservableOption<MediaStream>
    readonly #monitor: BrowserMonitor

    #gainDb: number = 0.0
    #audioChain: Nullable<AudioChain> = null
    #preparedWorklet: Nullable<RecordingWorklet> = null
    #streamNamedDeviceId: Optional<string> = undefined

    // the request is read when an open starts and again when it resolves, because getUserMedia cannot be cancelled
    constructor(project: Project, uuid: UUID.Bytes, request: Provider<Option<AudioInputRequest>>) {
        this.#project = project
        this.#request = request
        this.#stream = new MutableObservableOption<MediaStream>()
        this.#monitor = new BrowserMonitor(project.env.audioContext, project.engine, uuid)
    }

    get monitor(): BrowserMonitor {return this.#monitor}
    get nodes(): Option<AudioInputNodes> {return Option.wrap(this)}
    get stream(): MutableObservableOption<MediaStream> {return this.#stream}
    get streamMediaTrack(): Option<MediaStreamTrack> {
        return this.#stream.flatMap(stream => Option.wrap(stream.getAudioTracks().at(0)))
    }
    get outputNode(): Option<AudioNode> {return Option.wrap(this.#audioChain?.recordGainNode)}
    get monitorGainNode(): GainNode {return this.#monitor.gainNode}
    get monitorPanNode(): StereoPannerNode {return this.#monitor.panNode}
    get deviceId(): Option<string> {return this.streamMediaTrack.map(track => track.getSettings().deviceId ?? "")}
    get label(): Option<string> {return this.streamMediaTrack.map(track => track.label ?? "")}
    get channelCount(): 1 | 2 {return this.#audioChain?.channelCount ?? 1}
    set gainDb(value: number) {
        this.#gainDb = value
        if (isDefined(this.#audioChain)) {
            this.#audioChain.recordGainNode.gain.value = dbToGain(this.#gainDb)
        }
    }

    async open(): Promise<void> {
        const request = this.#request()
        if (request.isEmpty()) {return}
        const namedDeviceId = request.unwrap().deviceId.unwrapOrUndefined()
        if (this.#stream.nonEmpty()) {
            const openTrack = this.#stream.unwrap().getAudioTracks().at(0)
            const settings = openTrack?.getSettings()
            if (isDefined(openTrack) && openTrack.readyState === "live" && isDefined(settings)) {
                // an unnamed device never equals the reported id, so compare the request instead
                const unchanged = isUndefined(namedDeviceId)
                    ? isUndefined(this.#streamNamedDeviceId)
                    : namedDeviceId === settings.deviceId
                if (unchanged) {
                    return Promise.resolve()
                }
            }
        }
        this.close()
        const deviceId = namedDeviceId ?? AudioDevices.defaultInput?.deviceId
        const channelCount = this.#channels().unwrapOrElse(2)
        const stream = await this.#requestStream(deviceId, channelCount)
        if (!isDefined(stream)) {return}
        const resolved = this.#request()
        if (resolved.isEmpty() || namedDeviceId !== resolved.unwrap().deviceId.unwrapOrUndefined()) {
            stream.getAudioTracks().forEach(track => track.stop())
            return
        }
        const track = stream.getAudioTracks().at(0)
        const settings = track?.getSettings()
        console.debug(`new stream. device requested: ${deviceId ?? "default"}, got: ${settings?.deviceId ?? "unknown"}. channelCount requested: ${channelCount}, got: ${settings?.channelCount}`)
        this.#rebuildAudioChain(stream)
        this.#streamNamedDeviceId = namedDeviceId
        this.#stream.wrap(stream)
    }

    rechannel(): void {this.#stream.ifSome(stream => this.#rebuildAudioChain(stream))}

    close(): void {
        this.#monitor.unbind()
        this.#destroyAudioChain()
        this.#stream.clear(stream => stream.getAudioTracks().forEach(track => track.stop()))
    }

    async prepareRecording(open: Func<void, Promise<void>>): Promise<void> {
        const {env: {audioContext, audioWorklets, sampleManager, sampleService}, timelineBox} = this.#project
        // a prepared worklet that startRecording never consumed stays connected and buffering forever
        this.#discardPreparedWorklet()
        if (!await BrowserRecordingLatency.approveMissing(audioContext)) {
            return Promise.reject("Recording cancelled")
        }
        await AudioContexts.resume(audioContext)
        if (audioContext.state !== "running") {
            return Promise.reject(`Cannot record while the audio context is '${audioContext.state}'.`)
        }
        await open()
        // a source that went unpulled or saw another stream open stays ~24 ms late, a fresh node on the stream resets it
        this.#stream.ifSome(stream => this.#rebuildAudioChain(stream))
        const audioChain = this.#audioChain
        if (!isDefined(audioChain)) {
            return Promise.reject("No audio chain available for recording.")
        }
        const {recordGainNode, channelCount} = audioChain
        const recordingWorklet = audioWorklets.createRecording(UUID.generate(), channelCount, RecordingRingChunks)
        recordingWorklet.bpm = timelineBox.bpm.getValue()
        recordingWorklet.sampleService = sampleService
        sampleManager.record(recordingWorklet)
        recordGainNode.connect(recordingWorklet)
        this.#preparedWorklet = recordingWorklet
    }

    takeRecording(): Option<RecordingSink> {
        const audioChain = this.#audioChain
        const recordingWorklet = this.#preparedWorklet
        if (!isDefined(audioChain) || !isDefined(recordingWorklet)) {
            this.#discardPreparedWorklet()
            return Option.None
        }
        this.#preparedWorklet = null
        const {recordGainNode} = audioChain
        return Option.wrap({
            uuid: recordingWorklet.uuid,
            get firstQuantumTime() {return recordingWorklet.firstQuantumTime},
            get numberOfFrames() {return recordingWorklet.numberOfFrames},
            limit: count => recordingWorklet.limit(count),
            setFillLength: value => recordingWorklet.setFillLength(value),
            set onSaved(callback: Exec) {recordingWorklet.onSaved = callback},
            disconnect: () => tryCatch(() => recordGainNode.disconnect(recordingWorklet)),
            terminate: () => recordingWorklet.terminate()
        } satisfies RecordingSink)
    }

    readLatency(resolveInput: (outputLatency: number) => number): Provider<RecordingLatency> {
        const {audioContext} = this.#project.env
        const read = BrowserRecordingLatency.reader(audioContext, resolveInput)
        const track = this.streamMediaTrack.unwrapOrUndefined()
        const trackSettings = track?.getSettings()
        console.debug("[CaptureAudio] latency report", {
            outputLatency: audioContext.outputLatency,
            baseLatency: audioContext.baseLatency,
            inputLatencyReported: trackSettings?.latency,
            inputLatencyApplied: read().inputLatency,
            deviceId: trackSettings?.deviceId,
            deviceLabel: track?.label
        })
        return read
    }

    terminate(): void {
        this.#discardPreparedWorklet()
        this.close()
        this.#monitor.terminate()
    }

    #channels(): Option<1 | 2> {return this.#request().flatMap(({channels}) => channels)}

    // a gone device (unplugged, swapped by the OS) falls back to the default input instead of failing
    async #requestStream(deviceId: Optional<string>, channelCount: 1 | 2): Promise<Nullable<MediaStream>> {
        const baseConstraints: MediaTrackConstraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: {ideal: channelCount}
        }
        return AudioDevices.requestStream({
            ...baseConstraints,
            deviceId: isDefined(deviceId) ? {exact: deviceId} : undefined
        }).catch(error => {
            if (!isDefined(deviceId)) {throw error}
            if (this.#request().isEmpty()) {return null}
            console.warn(`Requested audio device '${deviceId}' unavailable (${String(error)}); using default input`)
            return AudioDevices.requestStream(baseConstraints)
        })
    }

    #rebuildAudioChain(stream: MediaStream): void {
        this.#monitor.unbind()
        this.#destroyAudioChain()
        const {audioContext} = this.#project.env
        const sourceNode = audioContext.createMediaStreamSource(stream)
        const recordGainNode = audioContext.createGain()
        recordGainNode.gain.value = dbToGain(this.#gainDb)
        const streamChannelCount: 1 | 2 = Math.min(stream.getAudioTracks().at(0)?.getSettings().channelCount ?? 2, 2) as 1 | 2
        const channelCount = this.#channels().unwrapOrElse(streamChannelCount)
        recordGainNode.channelCount = channelCount
        recordGainNode.channelCountMode = "explicit"
        sourceNode.connect(recordGainNode)
        // the engine splits its monitoring input discretely, so a forced mono must arrive already mixed down
        const monitorMixdown = audioContext.createGain()
        monitorMixdown.gain.value = 1.0
        monitorMixdown.channelCount = channelCount
        monitorMixdown.channelCountMode = "explicit"
        monitorMixdown.channelInterpretation = "speakers"
        sourceNode.connect(monitorMixdown)
        // a silent sink on the destination keeps the source pulled, so its input delay stays settled
        const keepAliveSink = audioContext.createGain()
        keepAliveSink.gain.value = 0.0
        sourceNode.connect(keepAliveSink)
        keepAliveSink.connect(audioContext.destination)
        this.#audioChain = {sourceNode, recordGainNode, monitorMixdown, keepAliveSink, channelCount}
        this.#monitor.bind({sourceNode, monitorMixdown, channelCount})
    }

    #discardPreparedWorklet(): void {
        const recordingWorklet = this.#preparedWorklet
        if (!isDefined(recordingWorklet)) {return}
        this.#preparedWorklet = null
        tryCatch(() => this.#audioChain?.recordGainNode.disconnect(recordingWorklet))
        this.#project.env.sampleManager.remove(recordingWorklet.uuid)
        recordingWorklet.terminate()
    }

    #destroyAudioChain(): void {
        if (isDefined(this.#audioChain)) {
            const {sourceNode, recordGainNode, monitorMixdown, keepAliveSink} = this.#audioChain
            sourceNode.disconnect()
            recordGainNode.disconnect()
            monitorMixdown.disconnect()
            keepAliveSink.disconnect()
            this.#audioChain = null
        }
    }
}
