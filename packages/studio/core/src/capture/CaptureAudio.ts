import {MutableObservableOption, Observer, Option, Subscription, Terminable} from "@opendaw/lib-std"
import {AudioUnitBox, CaptureAudioBox} from "@opendaw/studio-boxes"
import {Capture} from "./Capture"
import {CaptureDevices} from "./CaptureDevices"
import {MonitoringMode} from "./MonitoringMode"
import {AudioInputs} from "./AudioInputs"

// An audio track's input. It keeps the capture's settings; the input itself, its monitoring and recording come
// from the installed AudioInputs (the browser's by default).
export class CaptureAudio extends Capture<CaptureAudioBox> {
    readonly #connection: AudioInputs.Connection

    #monitoringMode: MonitoringMode = "off"
    #requestChannels: Option<1 | 2> = Option.None
    #gainDb: number = 0.0
    #monitorVolumeDb: number = 0.0
    #monitorPan: number = 0.0
    #monitorMuted: boolean = false

    constructor(manager: CaptureDevices, audioUnitBox: AudioUnitBox, captureAudioBox: CaptureAudioBox) {
        super(manager, audioUnitBox, captureAudioBox)
        this.#connection = AudioInputs.current().connect(this)
        this.ownAll(
            this.#connection,
            captureAudioBox.requestChannels.catchupAndSubscribe(owner => {
                const channels = owner.getValue()
                this.#requestChannels = channels === 1 || channels === 2 ? Option.wrap(channels) : Option.None
                this.#connection.channelsChanged()
            }),
            captureAudioBox.gainDb.catchupAndSubscribe(owner => {
                this.#gainDb = owner.getValue()
                this.#connection.gainChanged()
            }),
            captureAudioBox.deviceId.catchupAndSubscribe(async () => {
                if (this.armed.getValue()) {
                    await this.#connection.update()
                }
            }),
            this.armed.catchupAndSubscribe(async owner => {
                const armed = owner.getValue()
                if (armed) {
                    await this.#connection.update()
                } else {
                    this.#connection.stop()
                }
            })
        )
    }

    get isMonitoring(): boolean {return this.#monitoringMode !== "off"}
    get monitoringMode(): MonitoringMode {return this.#monitoringMode}
    set monitoringMode(value: MonitoringMode) {
        if (this.#monitoringMode === value) {return}
        this.#connection.disconnectMonitoring()
        this.#monitoringMode = value
        if (this.#monitoringMode !== "off") {
            this.armed.setValue(true)
        }
        this.#connection.connectMonitoring()
    }
    get gainDb(): number {return this.#gainDb}
    // input peaks measured outside the Web Audio graph (a host's own input); an empty array when that input stops
    subscribeInputPeaks(observer: Observer<Float32Array>): Subscription {return this.#connection.subscribePeaks(observer)}
    get requestChannels(): Option<1 | 2> {return this.#requestChannels}
    set requestChannels(value: 1 | 2) {this.captureBox.requestChannels.setValue(value)}
    get stream(): MutableObservableOption<MediaStream> {return this.#connection.stream}
    get streamDeviceId(): Option<string> {return this.#connection.streamDeviceId}
    get label(): string {return this.#connection.label}
    get deviceLabel(): Option<string> {return this.#connection.deviceLabel}
    get streamMediaTrack(): Option<MediaStreamTrack> {return this.#connection.streamMediaTrack}
    get outputNode(): Option<AudioNode> {return this.#connection.outputNode}
    get effectiveChannelCount(): number {return this.#connection.effectiveChannelCount}
    get monitorGainNode(): GainNode {return this.#connection.monitorGainNode}
    get monitorPanNode(): StereoPannerNode {return this.#connection.monitorPanNode}
    get monitorVolumeDb(): number {return this.#monitorVolumeDb}
    set monitorVolumeDb(value: number) {
        this.#monitorVolumeDb = value
        this.#connection.monitorLevelsChanged()
    }
    get monitorPan(): number {return this.#monitorPan}
    set monitorPan(value: number) {
        this.#monitorPan = value
        this.#connection.monitorLevelsChanged()
    }
    get monitorMuted(): boolean {return this.#monitorMuted}
    set monitorMuted(value: boolean) {
        this.#monitorMuted = value
        this.#connection.monitorLevelsChanged()
    }
    get monitorOutputDeviceId(): Option<string> {return this.#connection.monitorOutputDeviceId}

    setMonitorOutputDevice(deviceId: Option<string>): Promise<void> {return this.#connection.setMonitorOutputDevice(deviceId)}
    prepareRecording(): Promise<void> {return this.#connection.prepareRecording()}
    startRecording(): Terminable {return this.#connection.startRecording()}
}
