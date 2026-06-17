// Comprehensive rack: engine + filter + ring + delay, four independent modules sharing one memory.
// The engine generates a saw + sine, runs two filter instances, a ring-mod, and a heap delay, all
// wasm-to-wasm. Devices use safe DSP via the abi shim; engine assembles the descriptors.
type BootOptions = {
    engineModule: WebAssembly.Module
    filterModule: WebAssembly.Module
    ringModule: WebAssembly.Module
    delayModule: WebAssembly.Module
    sampleRate: number
    sawHz: number
    modHz: number
    cutoff1: number
    cutoff2: number
    ringGain: number
    feedback: number
}

type Device = { process: (descPtr: number) => void }

type EngineExports = {
    init: (sampleRate: number, sawHz: number, modHz: number,
           cutoff1: number, cutoff2: number, ringGain: number, feedback: number) => void
    out_ptr: () => number
    render: (frames: number) => void
}

class RackEngine extends AudioWorkletProcessor {
    readonly #memory: WebAssembly.Memory
    readonly #engine: EngineExports

    constructor(options?: AudioWorkletNodeOptions) {
        super()
        const {engineModule, filterModule, ringModule, delayModule, sampleRate,
            sawHz, modHz, cutoff1, cutoff2, ringGain, feedback}: BootOptions = options?.processorOptions
        this.#memory = new WebAssembly.Memory({initial: 256})
        const env = {memory: this.#memory}
        const filter = new WebAssembly.Instance(filterModule, {env}).exports as unknown as Device
        const ring = new WebAssembly.Instance(ringModule, {env}).exports as unknown as Device
        const delay = new WebAssembly.Instance(delayModule, {env}).exports as unknown as Device
        this.#engine = new WebAssembly.Instance(engineModule, {
            env,
            filter: {process: filter.process},
            ring: {process: ring.process},
            delay: {process: delay.process}
        }).exports as unknown as EngineExports
        this.#engine.init(sampleRate, sawHz, modHz, cutoff1, cutoff2, ringGain, feedback)
    }

    process(_inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean {
        const out = outputs[0]
        if (out.length === 0) {return true}
        const frames = out[0].length
        this.#engine.render(frames)
        const view = new Float32Array(this.#memory.buffer, this.#engine.out_ptr(), frames)
        out[0].set(view)
        for (let channel = 1; channel < out.length; channel++) {out[channel].set(out[0])}
        return true
    }
}

registerProcessor("rack", RackEngine)

export {} // isolate this file's scope (module) so its types don't collide with other worklets
