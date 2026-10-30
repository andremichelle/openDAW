import {
    Exec,
    Func,
    isDefined,
    isUndefined,
    MutableObservableOption,
    Nullable,
    Option,
    int,
    Optional,
    Provider,
    Subscription,
    Terminable,
    Terminator,
    TimeSpan,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {dbToGain} from "@opendaw/lib-dsp"
import {Runtime, Wait} from "@opendaw/lib-runtime"
import type {Project} from "../../project"
import {AudioContexts} from "../../AudioContexts"
import {AudioDevices} from "../../AudioDevices"
import {RecordingWorklet} from "../../RecordingWorklet"
import {AudioInputNodes, AudioInputPort, AudioInputRequest} from "../AudioInputPort"
import {RecordingLatency} from "../RecordingLatency"
import {RecordingSink} from "../RecordingSink"
import {RoundTrip} from "../RoundTrip"
import {BrowserRoundTrips} from "./BrowserRoundTrips"
import {BrowserMonitor} from "./BrowserMonitor"
import {BrowserRecordingLatency} from "./BrowserRecordingLatency"

// Ring capacity in render-quantum chunks (~3s at 48kHz). The reader worker keeps the ring drained in real time;
// the headroom only needs to cover the worker's async boot and transient stalls. See issue #290.
const RecordingRingChunks = 1024
const ProbeBursts = 3
const ProbeGain = 0.25
const ProbeLeadSeconds = 0.3
// a fresh source node steps by a render quantum or two in its first second, rebuilt early it settles before a take
const FreshSourceDelayMillis = 250

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
    readonly #lifecycle: Terminator = new Terminator()

    #gainDb: number = 0.0
    #freshSource: Nullable<Subscription> = null
    #freshSourcePending: boolean = false
    #changingStreams: boolean = false
    #activeSinks: int = 0
    #audioChain: Nullable<AudioChain> = null
    #preparedWorklet: Nullable<RecordingWorklet> = null
    #streamNamedDeviceId: Optional<string> = undefined
    #outputName: string = ""

    // the request is read when an open starts and again when it resolves, because getUserMedia cannot be cancelled
    constructor(project: Project, uuid: UUID.Bytes, request: Provider<Option<AudioInputRequest>>) {
        this.#project = project
        this.#request = request
        this.#stream = new MutableObservableOption<MediaStream>()
        this.#monitor = new BrowserMonitor(project.env.audioContext, project.engine, uuid)
        // a live source reads ~24 ms late for good after another stream opened or closed, the device list changed
        // or the context paused: a fresh source node on the same stream reads in time again
        const {audioContext} = project.env
        const listen = (target: Optional<EventTarget>, type: string, listener: Exec): Subscription => {
            if (!isDefined(target) || typeof target.addEventListener !== "function") {return Terminable.Empty}
            target.addEventListener(type, listener)
            return Terminable.create(() => target.removeEventListener(type, listener))
        }
        this.#lifecycle.ownAll(
            AudioDevices.subscribeStreamsChanged(() => {if (!this.#changingStreams) {this.#scheduleFreshSource()}}),
            listen(Reflect.get(navigator, "mediaDevices"), "devicechange", () => this.#scheduleFreshSource()),
            listen(audioContext, "statechange", () => {if (audioContext.state === "running") {this.#scheduleFreshSource()}}),
            Terminable.create(() => this.#freshSource?.terminate())
        )
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
        this.#changingStreams = true
        const stream = await this.#requestStream(deviceId, channelCount).finally(() => this.#changingStreams = false)
        if (!isDefined(stream)) {return}
        const resolved = this.#request()
        if (resolved.isEmpty() || namedDeviceId !== resolved.unwrap().deviceId.unwrapOrUndefined()) {
            this.#stopTracks(stream)
            return
        }
        const track = stream.getAudioTracks().at(0)
        const settings = track?.getSettings()
        console.debug(`new stream. device requested: ${deviceId ?? "default"}, got: ${settings?.deviceId ?? "unknown"}. channelCount requested: ${channelCount}, got: ${settings?.channelCount}`)
        this.#rebuildAudioChain(stream)
        this.#streamNamedDeviceId = namedDeviceId
        this.#stream.wrap(stream)
        await this.#resolveOutputName()
    }

    rechannel(): void {this.#stream.ifSome(stream => this.#rebuildAudioChain(stream))}

    close(): void {
        this.#monitor.unbind()
        this.#destroyAudioChain()
        this.#stream.clear(stream => this.#stopTracks(stream))
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
        await this.#resolveOutputName()
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
        this.#activeSinks++
        const {recordGainNode} = audioChain
        let connected = true
        return Option.wrap({
            uuid: recordingWorklet.uuid,
            get firstQuantumTime() {return recordingWorklet.firstQuantumTime},
            get numberOfFrames() {return recordingWorklet.numberOfFrames},
            limit: count => recordingWorklet.limit(count),
            setFillLength: value => recordingWorklet.setFillLength(value),
            set onSaved(callback: Exec) {recordingWorklet.onSaved = callback},
            disconnect: () => {
                if (!connected) {return}
                connected = false
                tryCatch(() => recordGainNode.disconnect(recordingWorklet))
                this.#activeSinks--
                this.#catchUpFreshSource()
            },
            terminate: () => recordingWorklet.terminate()
        } satisfies RecordingSink)
    }

    get roundTrip(): Option<RoundTrip.Entry> {
        return BrowserRoundTrips.find(this.#outputName, this.label.unwrapOrElse(""), this.#project.env.audioContext.sampleRate)
    }

    readLatency(resolveInput: (outputLatency: number) => number, calibrated: boolean): Provider<RecordingLatency> {
        const {audioContext} = this.#project.env
        const roundTrip = calibrated ? this.roundTrip : Option.None
        const read: Provider<RecordingLatency> = roundTrip.match({
            none: () => BrowserRecordingLatency.reader(audioContext, resolveInput),
            some: ({seconds}) => () => ({outputLatency: seconds, inputLatency: 0.0})
        })
        const track = this.streamMediaTrack.unwrapOrUndefined()
        const trackSettings = track?.getSettings()
        console.debug("[CaptureAudio] latency report", {
            outputLatency: audioContext.outputLatency,
            baseLatency: audioContext.baseLatency,
            inputLatencyReported: trackSettings?.latency,
            inputLatencyApplied: read().inputLatency,
            roundTrip: roundTrip.mapOr(({seconds}) => seconds, null),
            output: this.#outputName,
            deviceId: trackSettings?.deviceId,
            deviceLabel: track?.label
        })
        return read
    }

    async measureRoundTrip(): Promise<RoundTrip.Result> {
        const {env: {audioContext, audioWorklets}} = this.#project
        if (this.#stream.isEmpty()) {return Promise.reject("The input is not open.")}
        await AudioContexts.resume(audioContext)
        await this.#resolveOutputName()
        const audioChain = this.#audioChain
        if (!isDefined(audioChain)) {return Promise.reject("The input is not open.")}
        const {recordGainNode, channelCount} = audioChain
        const {sampleRate} = audioContext
        const capture = audioWorklets.createRecording(UUID.generate(), channelCount, RecordingRingChunks)
        recordGainNode.connect(capture)
        const probe = RoundTrip.probe()
        const buffer = audioContext.createBuffer(1, probe.length, sampleRate)
        buffer.copyToChannel(probe, 0)
        const level = audioContext.createGain()
        level.gain.value = ProbeGain
        level.connect(audioContext.destination)
        const spacing = probe.length / sampleRate + RoundTrip.BurstGapSeconds
        const first = audioContext.currentTime + ProbeLeadSeconds
        const emissions = Array.from({length: ProbeBursts}, (_, index) => first + index * spacing)
        emissions.forEach(time => {
            const source = audioContext.createBufferSource()
            source.buffer = buffer
            source.connect(level)
            source.start(time)
        })
        await Wait.timeSpan(TimeSpan.seconds(ProbeLeadSeconds + ProbeBursts * spacing + RoundTrip.MaxSeconds))
        tryCatch(() => recordGainNode.disconnect(capture))
        level.disconnect()
        const planes = capture.capturedFrames
        const firstFrameTime = capture.firstQuantumTime
        capture.terminate()
        if (planes.length === 0 || firstFrameTime.isEmpty()) {
            return {verdict: "no-signal", seconds: Number.NaN, spreadSeconds: Number.NaN, heard: 0, bursts: ProbeBursts}
        }
        const mono = new Float32Array(planes[0].length)
        planes.forEach(plane => plane.forEach((value, index) => mono[index] += value / planes.length))
        const result = RoundTrip.analyse(mono, firstFrameTime.unwrap(), sampleRate, emissions, probe)
        console.debug("[CaptureAudio] round trip", {...result, output: this.#outputName, input: this.label.unwrapOrElse("")})
        if (result.verdict === "ok") {
            BrowserRoundTrips.save({
                output: this.#outputName, input: this.label.unwrapOrElse(""), sampleRate,
                seconds: result.seconds, measuredAt: Date.now()
            })
        }
        return result
    }

    terminate(): void {
        this.#lifecycle.terminate()
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

    #scheduleFreshSource(): void {
        if (this.#stream.isEmpty()) {return}
        this.#freshSource?.terminate()
        this.#freshSource = Runtime.scheduleTimeout(() => {
            this.#freshSource = null
            if (this.#preparedWorklet !== null || this.#activeSinks > 0) {
                this.#freshSourcePending = true
                return
            }
            this.#stream.ifSome(stream => this.#rebuildAudioChain(stream))
        }, FreshSourceDelayMillis)
    }

    // a source that went late during a take is replaced once nothing records from it
    #catchUpFreshSource(): void {
        if (!this.#freshSourcePending || this.#preparedWorklet !== null || this.#activeSinks > 0) {return}
        this.#freshSourcePending = false
        this.#scheduleFreshSource()
    }

    #stopTracks(stream: MediaStream): void {
        stream.getAudioTracks().forEach(track => track.stop())
        this.#changingStreams = true
        AudioDevices.notifyStreamsChanged()
        this.#changingStreams = false
    }

    // a default device id follows the system, its name tells the devices apart
    async #resolveOutputName(): Promise<void> {
        const {audioContext} = this.#project.env
        const reported: unknown = Reflect.get(audioContext, "sinkId")
        const sinkId = typeof reported === "string" && reported !== "" ? reported : "default"
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
        this.#outputName = devices.find(device => device.kind === "audiooutput" && device.deviceId === sinkId)?.label ?? ""
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
        this.#catchUpFreshSource()
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
