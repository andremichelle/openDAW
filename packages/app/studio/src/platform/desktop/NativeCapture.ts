import {int, Notifier, Nullable, Option, Procedure, Subscription, TimeSpan, UUID} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {CaptureAudioBackend, MonitoringMode} from "@opendaw/studio-core"
import {NativeEnginePort} from "@/platform/desktop/bridge/NativeEnginePort"

// Audio input through the native engine: the engine opens the device, monitors and (later) records on its own clock
export namespace NativeCapture {
    type InputInfo = { name: string, channels: int }

    const state: { port: Nullable<NativeEnginePort>, info: Option<InputInfo> } = {port: null, info: Option.None}
    const inputs = new Set<NativeInput>()

    class NativeInput implements CaptureAudioBackend.Input {
        gain = 1.0
        mode: MonitoringMode = "off"
        volume = 1.0
        pan = 0.0
        readonly peaks = new Notifier<Float32Array>()

        constructor(readonly uuid: UUID.Bytes, readonly channelCount: 1 | 2, readonly label: string) {}

        get deviceId(): string {return "native"}

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

        send(): void {
            state.port?.send({
                type: "capture", uuid: this.uuid, channels: this.channelCount,
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

    export const updateInfo = (info: InputInfo): void => {state.info = info.channels > 0 ? Option.wrap(info) : Option.None}

    export const backend: CaptureAudioBackend = {
        open: async ({uuid, channels}) => {
            const pending = new NativeInput(uuid, channels, "")
            state.port?.send({type: "capture", uuid, channels, gain: 1.0, mode: "off", volume: 1.0, pan: 0.0})
            for (let attempt = 0; attempt < 40 && state.info.isEmpty(); attempt++) {await Wait.timeSpan(TimeSpan.millis(100))}
            if (state.info.isEmpty()) {
                pending.terminate()
                return Promise.reject(new Error("No audio input is available. Check the microphone permission for openDAW."))
            }
            const input = new NativeInput(uuid, channels, state.info.unwrap().name)
            inputs.add(input)
            input.send()
            return input
        }
    }
}
