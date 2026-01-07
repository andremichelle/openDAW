import {ExportStemsConfiguration} from "./EngineProcessorAttachment"

export interface OfflineEngineInitializeConfig {
    sampleRate: number
    numberOfChannels: number
    processorsUrl: string
    syncStreamBuffer: SharedArrayBuffer
    controlFlagsBuffer: SharedArrayBuffer
    project: ArrayBufferLike
    exportConfiguration?: ExportStemsConfiguration
}

export interface OfflineEngineRenderConfig {
    silenceThresholdDb?: number
    silenceDurationSeconds?: number
    maxDurationSeconds?: number
}

export interface OfflineEngineProtocol {
    initialize(enginePort: MessagePort, progressPort: MessagePort, config: OfflineEngineInitializeConfig): Promise<void>
    render(config: OfflineEngineRenderConfig): Promise<Float32Array[]>
    step(samples: number): Promise<Float32Array[]>
    stop(): void
}
