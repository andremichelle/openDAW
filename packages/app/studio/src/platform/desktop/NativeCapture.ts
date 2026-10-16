import {int, isDefined, Notifier, Nullable, Option, Procedure, Provider, Subscription, Terminable, TimeSpan, UUID} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {CaptureAudioBackend, MonitoringMode, RecordingTake} from "@opendaw/studio-core"
import {NativeEnginePort} from "@/platform/desktop/bridge/NativeEnginePort"

// Audio input through the native engine: the engine opens the device, monitors and (later) records on its own clock
export namespace NativeCapture {
    type InputInfo = { name: string, channels: int }

    const RenderQuantum = 128

    const state: {
        port: Nullable<NativeEnginePort>, info: Option<InputInfo>, devices: ReadonlyArray<InputInfo>
        inputLatency: number, outputLatency: Provider<number>
    } = {port: null, info: Option.None, devices: [], inputLatency: 0.0, outputLatency: () => 0.0}
    const inputs = new Set<NativeInput>()

    class NativeInput implements CaptureAudioBackend.Input {
        gain = 1.0
        mode: MonitoringMode = "off"
        volume = 1.0
        pan = 0.0
        readonly peaks = new Notifier<Float32Array>()
        take: Nullable<RecordingTake> = null

        constructor(readonly uuid: UUID.Bytes, readonly requestedDevice: string, readonly channelCount: 1 | 2) {}

        // the engine opens one input at a time, the name of the open one identifies it
        get deviceId(): string {return state.info.mapOr(info => info.name, "")}
        get label(): string {return state.info.mapOr(info => info.name, "No Input")}

        setGain(gain: number): void {
            this.gain = gain
            this.send()
        }

        setMonitoring(mode: MonitoringMode, volume: number, pan: number): void {
            this.mode = mode
            this.volume = volume
            this.pan = pan
            this.send()
        }

        subscribePeaks(observer: Procedure<Float32Array>): Subscription {return this.peaks.subscribe(observer)}

        record(take: RecordingTake): Terminable {
            this.take = take
            state.port?.send({type: "record", uuid: this.uuid, record: true})
            return Terminable.create(() => {
                if (this.take !== take) {return}
                this.take = null
                state.port?.send({type: "record", uuid: this.uuid, record: false})
            })
        }

        latency(): { output: number, input: number } {return {output: state.outputLatency(), input: state.inputLatency}}

        send(): void {
            state.port?.send({
                type: "capture", uuid: this.uuid, deviceId: this.requestedDevice, channels: this.channelCount,
                gain: this.gain, mode: this.mode, volume: this.volume, pan: this.pan
            })
        }

        terminate(): void {
            this.peaks.terminate()
            inputs.delete(this)
            state.port?.send({type: "capture-close", uuid: this.uuid})
        }
    }

    // a new engine instance (project load, restart) gets every open input again
    export const attachPort = (port: NativeEnginePort): void => {
        state.port = port
        inputs.forEach(input => input.send())
    }

    export const deliverPeaks = (uuid: Uint8Array, peaks: Float32Array): void =>
        inputs.forEach(input => {if (UUID.equals(input.uuid, uuid as UUID.Bytes)) {input.peaks.notify(peaks)}})

    // the engine sends the input after the gain in planes of whole render quanta, stamped once with its first quantum
    export const deliverRecording = (uuid: Uint8Array, first: number, planes: ReadonlyArray<Float32Array>): void =>
        inputs.forEach(input => {
            const take = input.take
            if (!isDefined(take) || !UUID.equals(input.uuid, uuid as UUID.Bytes)) {return}
            if (take.firstQuantumTime.isEmpty() && first >= 0.0) {take.firstQuantum(first)}
            const quanta = (planes[0]?.length ?? 0) / RenderQuantum
            for (let index = 0; index < quanta; index++) {
                take.append(planes.map(plane => plane.slice(index * RenderQuantum, (index + 1) * RenderQuantum)))
            }
        })

    export const updateInputLatency = (seconds: number): void => {state.inputLatency = seconds}
    export const outputLatency = (provider: Provider<number>): void => {state.outputLatency = provider}

    export const updateDevices = (devices: ReadonlyArray<InputInfo>): void => {state.devices = devices}

    export const updateInfo = (info: InputInfo): void => {state.info = info.channels > 0 ? Option.wrap(info) : Option.None}

    export const backend: CaptureAudioBackend = {
        devices: () => state.devices.map(({name}) => ({deviceId: name, label: name})),
        open: async ({uuid, deviceId, channels}) => {
            const requested = deviceId ?? ""
            const pending = new NativeInput(uuid, requested, channels)
            pending.send()
            for (let attempt = 0; attempt < 40 && state.info.isEmpty(); attempt++) {await Wait.timeSpan(TimeSpan.millis(100))}
            if (state.info.isEmpty()) {
                pending.terminate()
                return Promise.reject(new Error("No audio input is available. Check the microphone permission for openDAW."))
            }
            const input = new NativeInput(uuid, requested, channels)
            inputs.add(input)
            input.send()
            return input
        }
    }
}
