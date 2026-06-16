// Runs the sine wasm on the audio thread. Mirrors the calls verified in Node:
// init / process / out_ptr / memory view.
type BootOptions = {
    module: WebAssembly.Module
    sampleRate: number
    frequency: number
}

type EngineExports = {
    memory: WebAssembly.Memory
    init: (sampleRate: number, frequency: number) => void
    process: (frames: number) => void
    out_ptr: () => number
}

class SineEngine extends AudioWorkletProcessor {
    readonly #exports: EngineExports

    constructor(options?: AudioWorkletNodeOptions) {
        super()
        const {module, sampleRate, frequency}: BootOptions = options?.processorOptions
        this.#exports = new WebAssembly.Instance(module, {}).exports as unknown as EngineExports
        this.#exports.init(sampleRate, frequency)
    }

    process(_inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean {
        const out = outputs[0]
        if (out.length === 0) {return true}
        const frames = out[0].length
        this.#exports.process(frames)
        const view = new Float32Array(this.#exports.memory.buffer, this.#exports.out_ptr(), frames)
        out[0].set(view)
        for (let channel = 1; channel < out.length; channel++) {out[channel].set(out[0])}
        return true
    }
}

registerProcessor("engine", SineEngine)
