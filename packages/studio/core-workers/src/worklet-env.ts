type WorkletProcessorConstructor = new (options: Record<string, unknown>) => AudioWorkletProcessor

export type WorkletGlobals = {
    sampleRate: number
    currentFrame: number
    currentTime: number
    AudioWorkletProcessor: typeof AudioWorkletProcessor
    registerProcessor: (name: string, ctor: WorkletProcessorConstructor) => void
    __registeredProcessors__: Record<string, WorkletProcessorConstructor>
    __workletPort__: MessagePort
}

const globals = globalThis as unknown as WorkletGlobals

export class AudioWorkletProcessor {
    readonly port: MessagePort
    constructor() { this.port = globals.__workletPort__ }
    process(_inputs: Float32Array[][], _outputs: Float32Array[][]): boolean { return false }
}

export const setupWorkletGlobals = (config: { sampleRate: number }): void => {
    globals.sampleRate = config.sampleRate
    globals.currentFrame = 0
    globals.currentTime = 0
    globals.AudioWorkletProcessor = AudioWorkletProcessor
    globals.registerProcessor = (name: string, ctor: WorkletProcessorConstructor) => {
        globals.__registeredProcessors__ = globals.__registeredProcessors__ || {}
        globals.__registeredProcessors__[name] = ctor
    }
}

export const updateFrameTime = (frame: number, sampleRate: number): void => {
    globals.currentFrame = frame
    globals.currentTime = frame / sampleRate
}