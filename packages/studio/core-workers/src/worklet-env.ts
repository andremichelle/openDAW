export class AudioWorkletProcessor {
    readonly port: MessagePort
    constructor() { this.port = (globalThis as any).__workletPort__ }
}

export function setupWorkletGlobals(config: { sampleRate: number }): void {
    const g = globalThis as any
    g.sampleRate = config.sampleRate
    g.currentFrame = 0
    g.currentTime = 0
    g.AudioWorkletProcessor = AudioWorkletProcessor
    g.registerProcessor = (name: string, ctor: any) => {
        g.__registeredProcessors__ = g.__registeredProcessors__ || {}
        g.__registeredProcessors__[name] = ctor
    }
}

export function updateFrameTime(frame: number, sampleRate: number): void {
    const g = globalThis as any
    g.currentFrame = frame
    g.currentTime = frame / sampleRate
}