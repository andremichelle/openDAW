import {
    Func,
    isDefined,
    isUndefined,
    MutableObservableOption,
    Notifier,
    Nullable,
    Observer,
    Option,
    Optional,
    RuntimeNotifier,
    Subscription,
    Terminable,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {dbToGain} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {AudioContexts} from "../AudioContexts"
import {AudioDevices} from "../AudioDevices"
import {RecordingWorklet} from "../RecordingWorklet"
import {InputLatency} from "./InputLatency"
import {RecordAudio} from "./RecordAudio"
import type {AudioInputs} from "./AudioInputs"
import type {CaptureAudio} from "./CaptureAudio"

// Ring capacity in render-quantum chunks (~3s at 48kHz). The reader worker keeps the ring drained in real time;
// the headroom only needs to cover the worker's async boot and transient stalls. See issue #290.
const RecordingRingChunks = 1024

// The browser's audio inputs: getUserMedia, monitoring through the Web Audio graph, recording into a RecordingWorklet
export const WebAudioInputs: AudioInputs = {
    get requiresPermission(): boolean {return AudioDevices.inputs.length === 0},
    devices: (): ReadonlyArray<AudioInputs.Device> => AudioDevices.inputs,
    requestPermission: (): Promise<void> => AudioDevices.requestPermission(),
    connect: (capture: CaptureAudio): AudioInputs.Connection => new WebAudioConnection(capture)
}

class WebAudioConnection implements AudioInputs.Connection {
    readonly #capture: CaptureAudio
    readonly #stream: MutableObservableOption<MediaStream>
    readonly #streamGenerator: Func<void, Promise<void>>
    readonly #monitorGainNode: GainNode
    readonly #monitorPanNode: StereoPannerNode
    readonly #peaks: Notifier<Float32Array> = new Notifier<Float32Array>()

    #terminated: boolean = false
    #audioChain: Nullable<{
        sourceNode: MediaStreamAudioSourceNode
        recordGainNode: GainNode
        keepAliveSink: GainNode
        channelCount: 1 | 2
    }> = null
    #preparedWorklet: Nullable<RecordingWorklet> = null
    #streamNamedDeviceId: Optional<string> = undefined
    #monitorOutputDeviceId: Option<string> = Option.None
    #monitorAudioElement: Nullable<HTMLAudioElement> = null
    #monitorStreamDest: Nullable<MediaStreamAudioDestinationNode> = null

    constructor(capture: CaptureAudio) {
        this.#capture = capture
        const {audioContext} = capture.manager.project.env
        this.#monitorGainNode = audioContext.createGain()
        this.#monitorGainNode.gain.value = dbToGain(capture.monitorVolumeDb)
        this.#monitorPanNode = audioContext.createStereoPanner()
        this.#monitorPanNode.pan.value = capture.monitorPan
        this.#monitorGainNode.connect(this.#monitorPanNode)
        this.#stream = new MutableObservableOption<MediaStream>()
        this.#streamGenerator = Promises.sequentialize(() => this.#updateStream())
    }

    update(): Promise<void> {return this.#streamGenerator()}
    stop(): void {this.#stopStream()}
    channelsChanged(): void {this.#stream.ifSome(stream => this.#rebuildAudioChain(stream))}

    gainChanged(): void {
        if (isDefined(this.#audioChain)) {
            this.#audioChain.recordGainNode.gain.value = dbToGain(this.#capture.gainDb)
        }
    }

    monitorLevelsChanged(): void {
        const {monitorMuted, monitorVolumeDb, monitorPan} = this.#capture
        this.#monitorGainNode.gain.value = monitorMuted ? 0 : dbToGain(monitorVolumeDb)
        this.#monitorPanNode.pan.value = monitorPan
    }

    subscribePeaks(observer: Observer<Float32Array>): Subscription {return this.#peaks.subscribe(observer)}

    get stream(): MutableObservableOption<MediaStream> {return this.#stream}
    get streamDeviceId(): Option<string> {return this.streamMediaTrack.map(settings => settings.getSettings().deviceId ?? "")}
    get label(): string {return this.streamMediaTrack.mapOr(track => track.label, "Default")}
    get deviceLabel(): Option<string> {return this.streamMediaTrack.map(track => track.label ?? "")}
    get streamMediaTrack(): Option<MediaStreamTrack> {
        return this.#stream.flatMap(stream => Option.wrap(stream.getAudioTracks().at(0)))
    }
    get outputNode(): Option<AudioNode> {return Option.wrap(this.#audioChain?.recordGainNode)}
    get effectiveChannelCount(): number {return this.#audioChain?.channelCount ?? 1}
    get monitorGainNode(): GainNode {return this.#monitorGainNode}
    get monitorPanNode(): StereoPannerNode {return this.#monitorPanNode}
    get monitorOutputDeviceId(): Option<string> {return this.#monitorOutputDeviceId}

    async setMonitorOutputDevice(deviceId: Option<string>): Promise<void> {
        const oldDestination = this.#monitorDestination()
        this.#monitorOutputDeviceId = deviceId
        if (isDefined(this.#monitorAudioElement)) {
            this.#monitorAudioElement.pause()
            this.#monitorAudioElement.srcObject = null
            this.#monitorAudioElement = null
        }
        if (isDefined(this.#monitorStreamDest)) {
            this.#monitorStreamDest.disconnect()
            this.#monitorStreamDest = null
        }
        if (deviceId.nonEmpty()) {
            const {audioContext} = this.#capture.manager.project.env
            this.#monitorStreamDest = audioContext.createMediaStreamDestination()
            const audio = new Audio()
            audio.srcObject = this.#monitorStreamDest.stream
            try {
                await (audio as any).setSinkId(deviceId.unwrap())
                await audio.play()
                this.#monitorAudioElement = audio
            } catch (reason) {
                audio.srcObject = null
                this.#monitorStreamDest.disconnect()
                this.#monitorStreamDest = null
                this.#monitorOutputDeviceId = Option.None
                console.warn(reason)
                RuntimeNotifier.notify({message: "Output device error.", icon: "Warning"})
                return
            }
        }
        if (this.#capture.monitoringMode !== "off" && isDefined(this.#audioChain)) {
            this.#monitorPanNode.disconnect(oldDestination)
            this.#monitorPanNode.connect(this.#monitorDestination())
        }
    }

    async prepareRecording(): Promise<void> {
        const {project} = this.#capture.manager
        const {env: {audioContext, audioWorklets, sampleManager, sampleService}} = project
        // a prepared worklet that startRecording never consumed stays connected and buffering forever
        this.#discardPreparedWorklet()
        if (isUndefined(audioContext.outputLatency)) {
            const approved = await RuntimeNotifier.approve({
                headline: "Warning",
                message: "Your browser does not support 'output latency'. This will cause timing issue while recording.",
                approveText: "Ignore",
                cancelText: "Cancel"
            })
            if (!approved) {
                return Promise.reject("Recording cancelled")
            }
        }
        await AudioContexts.resume(audioContext)
        if (audioContext.state !== "running") {
            return Promise.reject(`Cannot record while the audio context is '${audioContext.state}'.`)
        }
        await this.#streamGenerator()
        const audioChain = this.#audioChain
        if (!isDefined(audioChain)) {
            return Promise.reject("No audio chain available for recording.")
        }
        const {recordGainNode, channelCount} = audioChain
        const recordingWorklet = audioWorklets.createRecording(UUID.generate(), channelCount, RecordingRingChunks)
        recordingWorklet.bpm = project.timelineBox.bpm.getValue()
        recordingWorklet.sampleService = sampleService
        sampleManager.record(recordingWorklet)
        recordGainNode.connect(recordingWorklet)
        this.#preparedWorklet = recordingWorklet
    }

    startRecording(): Terminable {
        const capture = this.#capture
        const {project} = capture.manager
        const {env: {audioContext, sampleManager}, engine} = project
        const audioChain = this.#audioChain
        const recordingWorklet = this.#preparedWorklet
        if (!isDefined(audioChain) || !isDefined(recordingWorklet)) {
            console.warn("No audio chain or worklet available for recording.")
            this.#discardPreparedWorklet()
            return Terminable.Empty
        }
        this.#preparedWorklet = null
        const {recordGainNode} = audioChain
        const track = this.#stream.unwrapOrNull()?.getAudioTracks().at(0)
        const trackSettings = track?.getSettings()
        const readLatency = (): RecordAudio.Latency => {
            const outputLatency = audioContext.outputLatency ?? 0
            return {
                outputLatency,
                inputLatency: InputLatency.resolve(
                    capture.captureBox.inputLatency.getValue(),
                    engine.preferences.settings.recording.inputLatency,
                    outputLatency)
            }
        }
        const {inputLatency} = readLatency()
        console.debug("[CaptureAudio] latency report", {
            outputLatency: audioContext.outputLatency,
            baseLatency: audioContext.baseLatency,
            inputLatencyReported: trackSettings?.latency,
            inputLatencyApplied: inputLatency,
            deviceId: trackSettings?.deviceId,
            deviceLabel: track?.label
        })
        return RecordAudio.start({
            recordingWorklet,
            sourceNode: recordGainNode,
            sampleManager,
            project,
            capture,
            readLatency
        })
    }

    terminate(): void {
        this.#terminated = true
        this.#discardPreparedWorklet()
        this.#stopStream()
        if (isDefined(this.#monitorAudioElement)) {
            this.#monitorAudioElement.pause()
            this.#monitorAudioElement.srcObject = null
        }
        this.#monitorGainNode.disconnect()
        this.#monitorPanNode.disconnect()
        this.#peaks.terminate()
    }

    async #updateStream(): Promise<void> {
        if (!this.#wantsStream()) {return}
        const namedDeviceId = this.#capture.deviceId.getValue().unwrapOrUndefined()
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
        this.#stopStream()
        const deviceId = namedDeviceId ?? AudioDevices.defaultInput?.deviceId
        const channelCount = this.#capture.requestChannels.unwrapOrElse(2)
        const baseConstraints: MediaTrackConstraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: {ideal: channelCount}
        }
        // `exact` forces the browser to honor the requested deviceId; if the
        // device is gone (USB unplug, OS swap, ...), getUserMedia rejects.
        // Fall back to a stream without a deviceId constraint, so recording
        // still works on the default input rather than failing outright.
        const stream: Nullable<MediaStream> = await AudioDevices.requestStream({
            ...baseConstraints,
            deviceId: isDefined(deviceId) ? {exact: deviceId} : undefined
        }).catch(error => {
            if (!isDefined(deviceId)) {throw error}
            if (!this.#wantsStream()) {return null}
            console.warn(`Requested audio device '${deviceId}' unavailable (${String(error)}); using default input`)
            return AudioDevices.requestStream(baseConstraints)
        })
        if (!isDefined(stream)) {return}
        if (!this.#wantsStream() || namedDeviceId !== this.#capture.deviceId.getValue().unwrapOrUndefined()) {
            stream.getAudioTracks().forEach(track => track.stop())
            return
        }
        const tracks = stream.getAudioTracks()
        const track = tracks.at(0)
        const settings = track?.getSettings()
        const gotDeviceId = settings?.deviceId
        console.debug(`new stream. device requested: ${deviceId ?? "default"}, got: ${gotDeviceId ?? "unknown"}. channelCount requested: ${channelCount}, got: ${settings?.channelCount}`)
        this.#rebuildAudioChain(stream)
        this.#streamNamedDeviceId = namedDeviceId
        this.#stream.wrap(stream)
    }

    // getUserMedia cannot be cancelled, so this is checked when an update starts and, with the device, when it resolves
    #wantsStream(): boolean {return this.#capture.armed.getValue() && !this.#terminated}

    #stopStream(): void {
        this.disconnectMonitoring()
        this.#destroyAudioChain()
        this.#stream.clear(stream => stream.getAudioTracks().forEach(track => track.stop()))
    }

    #rebuildAudioChain(stream: MediaStream): void {
        this.disconnectMonitoring()
        this.#destroyAudioChain()
        const {audioContext} = this.#capture.manager.project.env
        const sourceNode = audioContext.createMediaStreamSource(stream)
        const recordGainNode = audioContext.createGain()
        recordGainNode.gain.value = dbToGain(this.#capture.gainDb)
        const streamChannelCount: 1 | 2 = Math.min(stream.getAudioTracks().at(0)?.getSettings().channelCount ?? 2, 2) as 1 | 2
        const channelCount = this.#capture.requestChannels.unwrapOrElse(streamChannelCount)
        recordGainNode.channelCount = channelCount
        recordGainNode.channelCountMode = "explicit"
        sourceNode.connect(recordGainNode)
        // a silent sink on the destination keeps the source pulled, so its input delay stays settled
        const keepAliveSink = audioContext.createGain()
        keepAliveSink.gain.value = 0.0
        sourceNode.connect(keepAliveSink)
        keepAliveSink.connect(audioContext.destination)
        this.#audioChain = {sourceNode, recordGainNode, keepAliveSink, channelCount}
        this.connectMonitoring()
    }

    #discardPreparedWorklet(): void {
        const recordingWorklet = this.#preparedWorklet
        if (!isDefined(recordingWorklet)) {return}
        this.#preparedWorklet = null
        tryCatch(() => this.#audioChain?.recordGainNode.disconnect(recordingWorklet))
        this.#capture.manager.project.env.sampleManager.remove(recordingWorklet.uuid)
        recordingWorklet.terminate()
    }

    #destroyAudioChain(): void {
        if (isDefined(this.#audioChain)) {
            const {sourceNode, recordGainNode, keepAliveSink} = this.#audioChain
            sourceNode.disconnect()
            recordGainNode.disconnect()
            keepAliveSink.disconnect()
            this.#audioChain = null
        }
    }

    #monitorDestination(): AudioNode {
        return this.#monitorStreamDest ?? this.#capture.manager.project.env.audioContext.destination
    }

    connectMonitoring(): void {
        if (!isDefined(this.#audioChain)) {return}
        const {sourceNode, channelCount} = this.#audioChain
        switch (this.#capture.monitoringMode) {
            case "off":
                break
            case "direct":
                sourceNode.connect(this.#monitorGainNode)
                this.#monitorPanNode.connect(this.#monitorDestination())
                break
            case "effects":
                this.#capture.manager.project.engine.registerMonitoringSource(
                    this.#capture.audioUnitBox.address.uuid, sourceNode, channelCount, this.#monitorGainNode)
                this.#monitorPanNode.connect(this.#monitorDestination())
                break
        }
    }

    disconnectMonitoring(): void {
        if (!isDefined(this.#audioChain)) {return}
        switch (this.#capture.monitoringMode) {
            case "off":
                break
            case "direct":
                this.#audioChain.sourceNode.disconnect(this.#monitorGainNode)
                this.#monitorPanNode.disconnect(this.#monitorDestination())
                break
            case "effects":
                this.#capture.manager.project.engine.unregisterMonitoringSource(this.#capture.audioUnitBox.address.uuid)
                this.#monitorPanNode.disconnect(this.#monitorDestination())
                break
        }
    }
}
