import {ObservableValue, Terminable} from "@moises-ai/lib-std"

export interface VideoExportConfig {
    readonly width: number
    readonly height: number
    readonly frameRate: number
    readonly sampleRate: number
    readonly numberOfChannels: number
    readonly videoBitrate?: number
    readonly audioBitrate?: number
}

export interface VideoExporter extends Terminable {
    addFrame(canvas: OffscreenCanvas, audio: Float32Array[], timestampSeconds: number): Promise<void>
    finalize(): Promise<Uint8Array>
    readonly progress: ObservableValue<number>
}