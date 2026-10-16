import {Option, Optional, Procedure, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {MonitoringMode} from "./MonitoringMode"
import {RecordingTake} from "../RecordingTake"

// An audio input outside the Web Audio graph (the desktop app's native engine). Without an installed backend,
// CaptureAudio opens its input with getUserMedia as before.
export interface CaptureAudioBackend {
    open(request: CaptureAudioBackend.Request): Promise<CaptureAudioBackend.Input>
    devices(): ReadonlyArray<CaptureAudioBackend.Device>
}

export namespace CaptureAudioBackend {
    export type Request = { uuid: UUID.Bytes, deviceId: Optional<string>, channels: 1 | 2 }
    export type Device = { deviceId: string, label: string }

    export interface Input extends Terminable {
        readonly label: string
        readonly deviceId: string
        readonly channelCount: 1 | 2
        setGain(gain: number): void
        // volume is linear (0 when muted), pan as StereoPannerNode
        setMonitoring(mode: MonitoringMode, volume: number, pan: number): void
        // linear peaks per channel after the gain
        subscribePeaks(observer: Procedure<Float32Array>): Subscription
        // feeds the take with the input after the gain from now on, on the clock of the engine's recordingStarted
        record(take: RecordingTake): Terminable
        // seconds, measured by the backend
        latency(): { output: number, input: number }
    }

    const state: { backend: Option<CaptureAudioBackend> } = {backend: Option.None}

    export const install = (backend: CaptureAudioBackend): void => {state.backend = Option.wrap(backend)}
    export const current = (): Option<CaptureAudioBackend> => state.backend
}
