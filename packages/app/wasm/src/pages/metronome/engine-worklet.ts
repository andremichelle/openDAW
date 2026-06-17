// Runs the metronome engine wasm on the audio thread. It holds the wasm BoxGraph mirror; the main
// thread serializes SyncSource's UpdateTask[] into bytes and posts them here (the worklet has no TS
// graph to resolve types). Each batch -> apply_updates, then bind() once the TimelineBox exists.
// process() advances the transport one quantum and copies the engine's stereo output.

type BootOptions = {
    module: WebAssembly.Module
    sampleRate: number
}

type EngineExports = {
    memory: WebAssembly.Memory
    init: (sampleRate: number) => void
    input_ptr: () => number
    input_capacity: () => number
    apply_updates: (len: number) => number
    bind: () => number
    render: () => void
    output_ptr: () => number
}

class MetronomeEngine extends AudioWorkletProcessor {
    readonly #exports: EngineExports
    #bound: boolean = false

    constructor(options?: AudioWorkletNodeOptions) {
        super()
        const {module, sampleRate}: BootOptions = options?.processorOptions
        this.#exports = new WebAssembly.Instance(module, {}).exports as unknown as EngineExports
        this.#exports.init(sampleRate)
        this.port.onmessage = (event: MessageEvent) => this.#applyUpdates(event.data as ArrayBuffer)
    }

    #applyUpdates(bytes: ArrayBuffer): void {
        const array = new Uint8Array(bytes)
        if (array.length > this.#exports.input_capacity()) {return}
        new Uint8Array(this.#exports.memory.buffer, this.#exports.input_ptr(), array.length).set(array)
        this.#exports.apply_updates(array.length)
        if (!this.#bound && this.#exports.bind() === 0) {this.#bound = true}
    }

    process(_inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean {
        const out = outputs[0]
        if (out.length === 0) {return true}
        this.#exports.render()
        const frames = out[0].length // the render quantum (128)
        const buffer = this.#exports.memory.buffer
        const pointer = this.#exports.output_ptr()
        const left = new Float32Array(buffer, pointer, frames)
        const right = new Float32Array(buffer, pointer + frames * Float32Array.BYTES_PER_ELEMENT, frames)
        out[0].set(left)
        if (out.length > 1) {out[1].set(right)}
        return true
    }
}

registerProcessor("engine", MetronomeEngine)

export {} // isolate this file's module scope from other worklets
