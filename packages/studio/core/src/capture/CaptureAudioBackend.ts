import {Option, Optional, Procedure, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {MonitoringMode} from "./MonitoringMode"

// An audio input outside the Web Audio graph (the desktop app's native engine). Without an installed backend,
// CaptureAudio opens its input with getUserMedia as before.
export interface CaptureAudioBackend {
    open(request: CaptureAudioBackend.Request): Promise<CaptureAudioBackend.Input>
}

export namespace CaptureAudioBackend {
    export type Request = { uuid: UUID.Bytes, deviceId: Optional<string>, channels: 1 | 2 }

    export interface Input extends Terminable {
        readonly label: string
        readonly deviceId: string
        readonly channelCount: 1 | 2
        setGain(gain: number): void
        // volume is linear (0 when muted), pan as StereoPannerNode
        setMonitoring(mode: MonitoringMode, volume: number, pan: number): void
        // linear peaks per channel after the gain
        subscribePeaks(observer: Procedure<Float32Array>): Subscription
    }

    const state: { backend: Option<CaptureAudioBackend> } = {backend: Option.None}

    export const install = (backend: CaptureAudioBackend): void => {state.backend = Option.wrap(backend)}
    export const current = (): Option<CaptureAudioBackend> => state.backend
}
