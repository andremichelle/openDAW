import {
    Errors,
    Func,
    isDefined,
    isUndefined,
    MutableObservableOption,
    Nullable,
    Option,
    RuntimeNotifier,
    Terminable
} from "@opendaw/lib-std"
import {dbToGain} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitBox, CaptureAudioBox} from "@opendaw/studio-boxes"
import {Capture} from "./Capture"
import {CaptureDevices} from "./CaptureDevices"
import {RecordAudio} from "./RecordAudio"
import {AudioDevices} from "../AudioDevices"
import {RenderQuantum} from "../RenderQuantum"
import {RecordingWorklet} from "../RecordingWorklet"

export class CaptureAudio extends Capture<CaptureAudioBox> {
    readonly #stream: MutableObservableOption<MediaStream>

    readonly #streamGenerator: Func<void, Promise<void>>

    #isMonitoring: boolean = false
    #requestChannels: Option<1 | 2> = Option.None
    #gainDb: number = 0.0
    #audioChain: Nullable<{
        sourceNode: MediaStreamAudioSourceNode
        gainNode: GainNode
    }> = null
    #preparedWorklet: Nullable<RecordingWorklet> = null

    constructor(manager: CaptureDevices, audioUnitBox: AudioUnitBox, captureAudioBox: CaptureAudioBox) {
        super(manager, audioUnitBox, captureAudioBox)

        this.#stream = new MutableObservableOption<MediaStream>()
        this.#streamGenerator = Promises.sequentialize(() => this.#updateStream())

        this.ownAll(
            captureAudioBox.requestChannels.catchupAndSubscribe(owner => {
                const channels = owner.getValue()
                this.#requestChannels = channels === 1 || channels === 2 ? Option.wrap(channels) : Option.None
                this.#stream.ifSome(stream => this.#rebuildAudioChain(stream))
            }),
            captureAudioBox.gainDb.catchupAndSubscribe(owner => {
                this.#gainDb = owner.getValue()
                if (isDefined(this.#audioChain)) {
                    this.#audioChain.gainNode.gain.value = dbToGain(this.#gainDb)
                }
            }),
            captureAudioBox.deviceId.catchupAndSubscribe(async () => {
                if (this.armed.getValue()) {
                    await this.#streamGenerator()
                }
            }),
            this.armed.catchupAndSubscribe(async owner => {
                const armed = owner.getValue()
                if (armed) {
                    await this.#streamGenerator()
                } else {
                    this.#stopStream()
                }
            })
        )
    }

    get isMonitoring(): boolean {return this.#isMonitoring}
    set isMonitoring(value: boolean) {
        if (this.#isMonitoring === value) {return}
        this.#isMonitoring = value
        if (this.#isMonitoring) {
            this.armed.setValue(true)
            this.#connectMonitoring()
        } else {
            this.#disconnectMonitoring()
        }
    }
    get gainDb(): number {return this.#gainDb}
    get requestChannels(): Option<1 | 2> {return this.#requestChannels}
    set requestChannels(value: 1 | 2) {this.captureBox.requestChannels.setValue(value)}
    get stream(): MutableObservableOption<MediaStream> {return this.#stream}
    get streamDeviceId(): Option<string> {
        return this.streamMediaTrack.map(settings => settings.getSettings().deviceId ?? "")
    }
    get label(): string {return this.streamMediaTrack.mapOr(track => track.label, "Default")}
    get deviceLabel(): Option<string> {return this.streamMediaTrack.map(track => track.label ?? "")}
    get streamMediaTrack(): Option<MediaStreamTrack> {
        return this.#stream.flatMap(stream => Option.wrap(stream.getAudioTracks().at(0)))
    }
    get outputNode(): Option<AudioNode> {return Option.wrap(this.#audioChain?.gainNode)}
    get effectiveChannelCount(): number {return this.#audioChain?.gainNode.channelCount ?? 1}

    async prepareRecording(): Promise<void> {
        const {project} = this.manager
        const {env: {audioContext, audioWorklets, sampleManager}} = project
        if (isUndefined(audioContext.outputLatency)) {
            const approved = RuntimeNotifier.approve({
                headline: "Warning",
                message: "Your browser does not support 'output latency'. This will cause timing issue while recording.",
                approveText: "Ignore",
                cancelText: "Cancel"
            })
            if (!approved) {
                return Promise.reject("Recording cancelled")
            }
        }
        await this.#streamGenerator()
        const audioChain = this.#audioChain
        if (!isDefined(audioChain)) {
            return Promise.reject("No audio chain available for recording.")
        }
        const {gainNode} = audioChain
        const channelCount = gainNode.channelCount
        const recordingWorklet = audioWorklets.createRecording(channelCount, RenderQuantum)
        sampleManager.record(recordingWorklet)
        gainNode.connect(recordingWorklet)
        this.#preparedWorklet = recordingWorklet
    }

    startRecording(): Terminable {
        const {project} = this.manager
        const {env: {audioContext, sampleManager}} = project
        const audioChain = this.#audioChain
        const recordingWorklet = this.#preparedWorklet
        if (!isDefined(audioChain) || !isDefined(recordingWorklet)) {
            console.warn("No audio chain or worklet available for recording.")
            return Terminable.Empty
        }
        this.#preparedWorklet = null
        const {gainNode} = audioChain
        return RecordAudio.start({
            recordingWorklet,
            sourceNode: gainNode,
            sampleManager,
            project,
            capture: this,
            outputLatency: audioContext.outputLatency ?? 0
        })
    }

    async #updateStream(): Promise<void> {
        if (this.#stream.nonEmpty()) {
            const stream = this.#stream.unwrap()
            const settings = stream.getAudioTracks().at(0)?.getSettings()
            if (isDefined(settings)) {
                const deviceId = this.deviceId.getValue().unwrapOrUndefined()
                if (deviceId === settings.deviceId) {
                    return Promise.resolve()
                }
            }
        }
        this.#stopStream()
        const deviceId = this.deviceId.getValue().unwrapOrUndefined() ?? AudioDevices.defaultInput?.deviceId
        const channelCount = this.#requestChannels.unwrapOrElse(1)
        return AudioDevices.requestStream({
            deviceId: isDefined(deviceId) ? {exact: deviceId} : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: {ideal: channelCount}
        }).then(stream => {
            const tracks = stream.getAudioTracks()
            const track = tracks.at(0)
            const settings = track?.getSettings()
            const gotDeviceId = settings?.deviceId
            console.debug(`new stream. device requested: ${deviceId ?? "default"}, got: ${gotDeviceId ?? "unknown"}. channelCount requested: ${channelCount}, got: ${settings?.channelCount}`)
            if (isUndefined(deviceId) || deviceId === gotDeviceId) {
                this.#rebuildAudioChain(stream)
                this.#stream.wrap(stream)
            } else {
                stream.getAudioTracks().forEach(track => track.stop())
                return Errors.warn(`Could not find audio device with id: '${deviceId}' (got: '${gotDeviceId}')`)
            }
        })
    }

    #stopStream(): void {
        this.#destroyAudioChain()
        this.#stream.clear(stream => stream.getAudioTracks().forEach(track => track.stop()))
    }

    #rebuildAudioChain(stream: MediaStream): void {
        const wasMonitoring = this.#isMonitoring && isDefined(this.#audioChain)
        this.#destroyAudioChain()
        const {audioContext} = this.manager.project.env
        const sourceNode = audioContext.createMediaStreamSource(stream)
        const gainNode = audioContext.createGain()
        gainNode.gain.value = dbToGain(this.#gainDb)
        const streamChannelCount = stream.getAudioTracks().at(0)?.getSettings().channelCount ?? 1
        const requestMono = this.#requestChannels.mapOr(channels => channels === 1, false)
        if (requestMono && streamChannelCount === 2) {
            gainNode.channelCount = 1
            gainNode.channelCountMode = "explicit"
        }
        sourceNode.connect(gainNode)
        this.#audioChain = {sourceNode, gainNode}
        if (wasMonitoring || this.#isMonitoring) {
            this.#connectMonitoring()
        }
    }

    #destroyAudioChain(): void {
        if (isDefined(this.#audioChain)) {
            const {sourceNode, gainNode} = this.#audioChain
            sourceNode.disconnect()
            gainNode.disconnect()
            this.#audioChain = null
        }
    }

    #connectMonitoring(): void {
        if (isDefined(this.#audioChain)) {
            const {audioContext} = this.manager.project.env
            this.#audioChain.gainNode.connect(audioContext.destination)
        }
    }

    #disconnectMonitoring(): void {
        if (isDefined(this.#audioChain)) {
            const {audioContext} = this.manager.project.env
            this.#audioChain.gainNode.disconnect(audioContext.destination)
        }
    }
}
