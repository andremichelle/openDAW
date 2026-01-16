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

export class CaptureAudio extends Capture<CaptureAudioBox> {
    readonly #stream: MutableObservableOption<MediaStream>

    readonly #streamGenerator: Func<void, Promise<void>>

    #isMonitoring: boolean = false
    #requestChannels: Option<1 | 2> = Option.None
    #gainDb: number = 0.0

    #monitor: Nullable<{ sourceNode: MediaStreamAudioSourceNode, gainNode: GainNode }> = null

    constructor(manager: CaptureDevices, audioUnitBox: AudioUnitBox, captureAudioBox: CaptureAudioBox) {
        super(manager, audioUnitBox, captureAudioBox)

        this.#stream = new MutableObservableOption<MediaStream>()
        this.#streamGenerator = Promises.sequentialize(() => this.#updateStream())

        this.ownAll(
            captureAudioBox.requestChannels.catchupAndSubscribe(owner => {
                const channels = owner.getValue()
                this.#requestChannels = channels === 1 || channels === 2 ? Option.wrap(channels) : Option.None
            }),
            captureAudioBox.gainDb.catchupAndSubscribe(owner => {
                this.#gainDb = owner.getValue()
                if (isDefined(this.#monitor)) {
                    this.#monitor.gainNode.gain.value = dbToGain(this.#gainDb)
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
            this.#stream.ifSome(stream => this.#connectMonitoring(stream))
        } else {
            this.#disconnectMonitoring()
        }
    }
    get gainDb(): number {return this.#gainDb}
    get stream(): MutableObservableOption<MediaStream> {return this.#stream}
    get streamDeviceId(): Option<string> {
        return this.streamMediaTrack.map(settings => settings.getSettings().deviceId ?? "")
    }
    get label(): string {return this.streamMediaTrack.mapOr(track => track.label, "Default")}
    get deviceLabel(): Option<string> {return this.streamMediaTrack.map(track => track.label ?? "")}
    get streamMediaTrack(): Option<MediaStreamTrack> {
        return this.#stream.flatMap(stream => Option.wrap(stream.getAudioTracks().at(0)))
    }

    async prepareRecording(): Promise<void> {
        const {project} = this.manager
        const {env: {audioContext}} = project
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
        return this.#streamGenerator()
    }

    startRecording(): Terminable {
        const {project} = this.manager
        const {env: {audioContext, audioWorklets, sampleManager}} = project
        const streamOption = this.#stream
        if (streamOption.isEmpty()) {
            console.warn("No audio stream available for recording.")
            return Terminable.Empty
        }
        const mediaStream = streamOption.unwrap()
        const channelCount = mediaStream.getAudioTracks().at(0)?.getSettings().channelCount ?? 1
        const numChunks = 128
        const recordingWorklet = audioWorklets.createRecording(channelCount, numChunks)
        return RecordAudio.start({
            recordingWorklet,
            mediaStream,
            sampleManager,
            audioContext,
            project,
            capture: this,
            gainDb: this.#gainDb,
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
                this.#stream.wrap(stream)
                if (this.#isMonitoring) {
                    this.#connectMonitoring(stream)
                }
            } else {
                stream.getAudioTracks().forEach(track => track.stop())
                return Errors.warn(`Could not find audio device with id: '${deviceId}' (got: '${gotDeviceId}')`)
            }
        })
    }

    #stopStream(): void {
        this.#disconnectMonitoring()
        this.#stream.clear(stream => stream.getAudioTracks().forEach(track => track.stop()))
    }

    #connectMonitoring(stream: MediaStream): void {
        this.#disconnectMonitoring()
        const {audioContext} = this.manager.project.env
        const sourceNode = audioContext.createMediaStreamSource(stream)
        const gainNode = audioContext.createGain()
        gainNode.gain.value = dbToGain(this.#gainDb)
        sourceNode.connect(gainNode)
        gainNode.connect(audioContext.destination)
        this.#monitor = {sourceNode, gainNode}
    }

    #disconnectMonitoring(): void {
        if (isDefined(this.#monitor)) {
            const {sourceNode, gainNode} = this.#monitor
            sourceNode.disconnect()
            gainNode.disconnect()
        }
    }
}