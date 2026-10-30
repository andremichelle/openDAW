import {Func, MutableObservableOption, Option, Provider, Terminable, VitalSigns} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitBox, CaptureAudioBox} from "@opendaw/studio-boxes"
import {Capture} from "./Capture"
import {CaptureDevices} from "./CaptureDevices"
import {InputLatency} from "./InputLatency"
import {RecordAudio} from "./RecordAudio"
import {AudioInputNodes, AudioInputPort, AudioInputRequest, BrowserAudioInput, MonitoringMode, RoundTrip} from "../io"

export class CaptureAudio extends Capture<CaptureAudioBox> {
    readonly #vitalSigns: VitalSigns
    readonly #input: AudioInputPort
    readonly #streamGenerator: Func<void, Promise<void>>

    #requestChannels: Option<1 | 2> = Option.None
    #gainDb: number = 0.0

    constructor(manager: CaptureDevices, audioUnitBox: AudioUnitBox, captureAudioBox: CaptureAudioBox,
                createInput: CaptureAudio.InputFactory = request =>
                    new BrowserAudioInput(manager.project, audioUnitBox.address.uuid, request)) {
        super(manager, audioUnitBox, captureAudioBox)
        this.#vitalSigns = this.own(new VitalSigns())
        this.#input = createInput(() => this.#request())
        this.#streamGenerator = Promises.sequentialize(() => this.#input.open())
        this.ownAll(
            this.#input,
            captureAudioBox.requestChannels.catchupAndSubscribe(owner => {
                const channels = owner.getValue()
                this.#requestChannels = channels === 1 || channels === 2 ? Option.wrap(channels) : Option.None
                this.#input.rechannel()
            }),
            captureAudioBox.gainDb.catchupAndSubscribe(owner => {
                this.#gainDb = owner.getValue()
                this.#input.gainDb = this.#gainDb
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
                    this.#input.close()
                }
            })
        )
    }

    get input(): AudioInputPort {return this.#input}
    get isMonitoring(): boolean {return this.#input.monitor.mode !== "off"}
    get monitoringMode(): MonitoringMode {return this.#input.monitor.mode}
    set monitoringMode(value: MonitoringMode) {
        if (this.#input.monitor.mode === value) {return}
        this.#input.monitor.mode = value
        if (value !== "off") {
            this.armed.setValue(true)
        }
    }
    get gainDb(): number {return this.#gainDb}
    get requestChannels(): Option<1 | 2> {return this.#requestChannels}
    set requestChannels(value: 1 | 2) {this.captureBox.requestChannels.setValue(value)}
    get stream(): MutableObservableOption<MediaStream> {return this.#nodes().stream}
    get streamDeviceId(): Option<string> {return this.#input.deviceId}
    get label(): string {return this.#input.label.unwrapOrElse("Default")}
    get deviceLabel(): Option<string> {return this.#input.label}
    get streamMediaTrack(): Option<MediaStreamTrack> {return this.#input.nodes.flatMap(nodes => nodes.streamMediaTrack)}
    get outputNode(): Option<AudioNode> {return this.#input.nodes.flatMap(nodes => nodes.outputNode)}
    get effectiveChannelCount(): number {return this.#input.channelCount}
    get monitorGainNode(): GainNode {return this.#nodes().monitorGainNode}
    get monitorPanNode(): StereoPannerNode {return this.#nodes().monitorPanNode}
    get monitorVolumeDb(): number {return this.#input.monitor.volumeDb}
    set monitorVolumeDb(value: number) {this.#input.monitor.volumeDb = value}
    get monitorPan(): number {return this.#input.monitor.pan}
    set monitorPan(value: number) {this.#input.monitor.pan = value}
    get monitorMuted(): boolean {return this.#input.monitor.muted}
    set monitorMuted(value: boolean) {this.#input.monitor.muted = value}
    get monitorOutputDeviceId(): Option<string> {return this.#input.monitor.outputDeviceId}

    setMonitorOutputDevice(deviceId: Option<string>): Promise<void> {return this.#input.monitor.setOutputDevice(deviceId)}

    prepareRecording(): Promise<void> {return this.#input.prepareRecording(() => this.#streamGenerator())}

    // the measured round trip replaces both reported latencies, unless this track overrides its input latency
    get roundTrip(): Option<RoundTrip.Entry> {return this.#input.roundTrip}

    async measureRoundTrip(): Promise<RoundTrip.Result> {
        const {engine} = this.manager.project
        if (engine.isPlaying.getValue() || engine.isRecording.getValue()) {
            return Promise.reject("Stop the transport to measure the latency.")
        }
        this.armed.setValue(true)
        await this.#streamGenerator()
        return this.#input.measureRoundTrip()
    }

    startRecording(): Terminable {
        const {project} = this.manager
        const {env: {sampleManager}, engine} = project
        return this.#input.takeRecording().match({
            none: () => {
                console.warn("No audio chain or worklet available for recording.")
                return Terminable.Empty
            },
            some: sink => RecordAudio.start({
                sink, sampleManager, project, capture: this,
                readLatency: this.#input.readLatency(outputLatency => InputLatency.resolve(
                    this.captureBox.inputLatency.getValue(), engine.preferences.settings.recording.inputLatency, outputLatency),
                    this.captureBox.inputLatency.getValue() <= InputLatency.Inherit)
            })
        })
    }

    #request(): Option<AudioInputRequest> {
        if (!this.armed.getValue() || this.#vitalSigns.isTerminated) {return Option.None}
        return Option.wrap({deviceId: this.deviceId.getValue(), channels: this.#requestChannels})
    }

    #nodes(): AudioInputNodes {return this.#input.nodes.unwrap("The audio input has no Web Audio nodes")}
}

export namespace CaptureAudio {
    // the input reads what the capture asks for whenever it opens
    export type InputFactory = Func<Provider<Option<AudioInputRequest>>, AudioInputPort>
}
