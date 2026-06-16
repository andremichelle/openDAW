// Ambient types for the AudioWorkletGlobalScope — not in TS's standard DOM lib.
declare class AudioWorkletProcessor {
    readonly port: MessagePort

    constructor(options?: AudioWorkletNodeOptions)

    process(inputs: Array<Array<Float32Array>>,
            outputs: Array<Array<Float32Array>>,
            parameters: Record<string, Float32Array>): boolean
}

declare function registerProcessor(
    name: string,
    processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void

declare const sampleRate: number
