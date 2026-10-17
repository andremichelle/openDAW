import {
    Func,
    int,
    isDefined,
    MutableObservableOption,
    Notifier,
    Nullable,
    Observer,
    Option,
    Provider,
    Subscription,
    Terminable,
    TimeSpan,
    UUID
} from "@opendaw/lib-std"
import {dbToGain} from "@opendaw/lib-dsp"
import {Promises, Wait} from "@opendaw/lib-runtime"
import {AudioInputs, CaptureAudio, InputLatency, RecordAudio, RecordingTake} from "@opendaw/studio-core"
import {NativeEnginePort} from "@/platform/desktop/bridge/NativeEnginePort"
import {Shell} from "@/platform/desktop/Shell"

// Audio inputs through the native engine: it opens the device, monitors and records on its own clock.
// The engine opens one input device at a time, the one chosen last.
export namespace NativeAudioInputs {
    type InputInfo = { name: string, channels: int }

    const RenderQuantum = 128

    const state: {
        port: Nullable<NativeEnginePort>, info: Option<InputInfo>, devices: ReadonlyArray<InputInfo>
        inputLatency: number, outputLatency: Provider<number>
    } = {port: null, info: Option.None, devices: [], inputLatency: 0.0, outputLatency: () => 0.0}

    const connections = new Set<NativeConnection>()

    class NativeConnection implements AudioInputs.Connection {
        readonly #capture: CaptureAudio
        readonly #update: Func<void, Promise<void>>
        readonly #peaks: Notifier<Float32Array> = new Notifier<Float32Array>()
        readonly #stream: MutableObservableOption<MediaStream> = new MutableObservableOption<MediaStream>()
        readonly #monitorGainNode: GainNode
        readonly #monitorPanNode: StereoPannerNode

        #open: Nullable<{ deviceId: string, channels: 1 | 2 }> = null
        #take: Nullable<RecordingTake> = null
        #prepared: Nullable<{ take: RecordingTake, feed: Terminable }> = null
        #terminated: boolean = false

        constructor(capture: CaptureAudio) {
            this.#capture = capture
            const {audioContext} = capture.manager.project.env
            // part of CaptureAudio's API; the native engine monitors without them
            this.#monitorGainNode = audioContext.createGain()
            this.#monitorPanNode = audioContext.createStereoPanner()
            this.#update = Promises.sequentialize(() => this.#updateInput())
            connections.add(this)
        }

        get uuid(): UUID.Bytes {return this.#capture.audioUnitBox.address.uuid}
        get take(): Nullable<RecordingTake> {return this.#take}

        update(): Promise<void> {return this.#update()}

        stop(): void {
            if (!isDefined(this.#open)) {return}
            this.#open = null
            state.port?.send({type: "capture-close", uuid: this.uuid})
            this.#peaks.notify(new Float32Array(0))
        }

        channelsChanged(): void {if (isDefined(this.#open)) {void this.#update()}}
        gainChanged(): void {this.send()}
        connectMonitoring(): void {this.send()}
        disconnectMonitoring(): void {}
        monitorLevelsChanged(): void {this.send()}
        setMonitorOutputDevice(_deviceId: Option<string>): Promise<void> {return Promise.resolve()}

        subscribePeaks(observer: Observer<Float32Array>): Subscription {return this.#peaks.subscribe(observer)}
        deliverPeaks(peaks: Float32Array): void {this.#peaks.notify(peaks)}

        get stream(): MutableObservableOption<MediaStream> {return this.#stream}
        get streamDeviceId(): Option<string> {return isDefined(this.#open) ? state.info.map(info => info.name) : Option.None}
        get label(): string {return isDefined(this.#open) ? state.info.mapOr(info => info.name, "Default") : "Default"}
        get deviceLabel(): Option<string> {return this.streamDeviceId}
        get streamMediaTrack(): Option<MediaStreamTrack> {return Option.None}
        get outputNode(): Option<AudioNode> {return Option.None}
        get effectiveChannelCount(): number {return this.#open?.channels ?? 1}
        get monitorGainNode(): GainNode {return this.#monitorGainNode}
        get monitorPanNode(): StereoPannerNode {return this.#monitorPanNode}
        get monitorOutputDeviceId(): Option<string> {return Option.None}

        // the capture's state as the engine needs it
        send(): void {
            if (!isDefined(this.#open)) {return}
            const {gainDb, monitoringMode, monitorMuted, monitorVolumeDb, monitorPan} = this.#capture
            state.port?.send({
                type: "capture", uuid: this.uuid, deviceId: this.#open.deviceId, channels: this.#open.channels,
                gain: dbToGain(gainDb), mode: monitoringMode, volume: monitorMuted ? 0.0 : dbToGain(monitorVolumeDb), pan: monitorPan
            })
        }

        record(take: RecordingTake): Terminable {
            this.#take = take
            state.port?.send({type: "record", uuid: this.uuid, record: true})
            return Terminable.create(() => {
                if (this.#take !== take) {return}
                this.#take = null
                state.port?.send({type: "record", uuid: this.uuid, record: false})
            })
        }

        async prepareRecording(): Promise<void> {
            this.#discardPrepared()
            await this.#update()
            if (!isDefined(this.#open)) {return Promise.reject("No audio input available for recording.")}
            const {project} = this.#capture.manager
            const {env: {sampleManager, sampleService}} = project
            const feed: { current: Terminable } = {current: Terminable.Empty}
            const take = new RecordingTake(UUID.generate(), project.engine.sampleRate, this.#open.channels, () => feed.current.terminate())
            take.bpm = project.timelineBox.bpm.getValue()
            take.sampleService = sampleService
            sampleManager.record(take)
            feed.current = this.record(take)
            this.#prepared = {take, feed: feed.current}
        }

        startRecording(): Terminable {
            const prepared = this.#prepared
            if (!isDefined(this.#open) || !isDefined(prepared)) {
                console.warn("No native input or take available for recording.")
                this.#discardPrepared()
                return Terminable.Empty
            }
            this.#prepared = null
            const capture = this.#capture
            const {project} = capture.manager
            const {env: {sampleManager}, engine} = project
            const readLatency = (): RecordAudio.Latency => ({
                outputLatency: state.outputLatency(),
                inputLatency: InputLatency.resolve(
                    capture.captureBox.inputLatency.getValue(), engine.preferences.settings.recording.inputLatency, state.inputLatency)
            })
            console.debug("[CaptureAudio] native latency report", readLatency())
            return RecordAudio.start({
                recordingWorklet: prepared.take,
                sourceNode: {disconnect: () => prepared.feed.terminate()},
                sampleManager,
                project,
                capture,
                readLatency
            })
        }

        terminate(): void {
            this.#terminated = true
            this.#discardPrepared()
            this.stop()
            this.#monitorGainNode.disconnect()
            this.#monitorPanNode.disconnect()
            this.#peaks.terminate()
            connections.delete(this)
        }

        #wanted(): boolean {return this.#capture.armed.getValue() && !this.#terminated}

        async #updateInput(): Promise<void> {
            if (!this.#wanted()) {return}
            const deviceId = this.#capture.deviceId.getValue().unwrapOrElse("")
            const channels = this.#capture.requestChannels.unwrapOrElse(2)
            if (this.#open?.deviceId === deviceId && this.#open.channels === channels) {return}
            this.stop()
            this.#open = {deviceId, channels}
            this.send()
            for (let attempt = 0; attempt < 40 && state.info.isEmpty(); attempt++) {await Wait.timeSpan(TimeSpan.millis(100))}
            if (state.info.isEmpty()) {
                this.stop()
                return Promise.reject(new Error("No audio input is available. Check the microphone permission for openDAW."))
            }
            if (!this.#wanted()) {this.stop()}
        }

        #discardPrepared(): void {
            const prepared = this.#prepared
            if (!isDefined(prepared)) {return}
            this.#prepared = null
            prepared.feed.terminate()
            this.#capture.manager.project.env.sampleManager.remove(prepared.take.uuid)
            prepared.take.terminate()
        }
    }

    export const strategy: AudioInputs = {
        requiresPermission: false,
        devices: () => state.devices.map(({name}) => ({deviceId: name, label: name})),
        requestPermission: () => Promise.resolve(),
        connect: capture => new NativeConnection(capture)
    }

    const find = (uuid: Uint8Array): Option<NativeConnection> =>
        Option.wrap(Array.from(connections).find(connection => UUID.equals(connection.uuid, uuid as UUID.Bytes)))

    // a new engine instance (project load, restart) gets every open input again
    export const attachPort = (port: NativeEnginePort): void => {
        state.port = port
        connections.forEach(connection => connection.send())
    }

    export const deliverPeaks = (uuid: Uint8Array, peaks: Float32Array): void =>
        find(uuid).ifSome(connection => connection.deliverPeaks(peaks))

    // the engine sends the input after the gain in planes of whole render quanta, stamped with its first quantum
    export const deliverRecording = (uuid: Uint8Array, first: number, planes: ReadonlyArray<Float32Array>): void =>
        find(uuid).ifSome(connection => {
            const take = connection.take
            if (!isDefined(take)) {return}
            if (take.firstQuantumTime.isEmpty() && first >= 0.0) {take.firstQuantum(first)}
            const quanta = (planes[0]?.length ?? 0) / RenderQuantum
            for (let index = 0; index < quanta; index++) {
                take.append(planes.map(plane => plane.slice(index * RenderQuantum, (index + 1) * RenderQuantum)))
            }
        })

    // installed before the studio boots, every capture binds its inputs when it is created
    export const install = (): void => {
        if (isDefined(Shell.info().engine)) {AudioInputs.install(strategy)}
    }

    export const updateInputLatency = (seconds: number): void => {state.inputLatency = seconds}
    export const outputLatency = (provider: Provider<number>): void => {state.outputLatency = provider}
    export const updateDevices = (devices: ReadonlyArray<InputInfo>): void => {state.devices = devices}
    export const updateInfo = (info: InputInfo): void => {state.info = info.channels > 0 ? Option.wrap(info) : Option.None}
}
