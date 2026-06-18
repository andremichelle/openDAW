// Runs the engine wasm on the audio thread, with the sine instrument loaded as a SEPARATE wasm plugin
// (device_sine.wasm) sharing one linear memory. The engine calls the device's `process` wasm-to-wasm
// (zero copy). The host wires the device's exports into the engine's imports and relocates the device's
// stack to an engine-(talc-)allocated block (so the two modules' stacks don't collide).
//
// The engine holds the wasm BoxGraph mirror; the main thread serializes SyncSource's UpdateTask[] into
// bytes and posts them here. Each batch -> apply_updates, then bind() once the TimelineBox exists.

type BootOptions = {
    engineModule: WebAssembly.Module
    instrumentModule: WebAssembly.Module
    sampleRate: number
    metronome?: boolean // default true; the note's page sets false to hear only the instrument
}

type InstrumentExports = {
    process: (descPtr: number) => void
    init: (sampleRate: number) => void
    state_size: () => number
    __stack_pointer: WebAssembly.Global
}

type EngineExports = {
    init: (sampleRate: number) => void
    setup_device: () => number
    input_ptr: () => number
    input_capacity: () => number
    apply_updates: (len: number) => number
    bind: () => number
    render: () => void
    output_ptr: () => number
    heap_used: () => number
    heap_claimed: () => number
    engine_state_ptr: () => number
    engine_state_len: () => number
    set_metronome_enabled: (enabled: number) => void
}

class EngineProcessor extends AudioWorkletProcessor {
    readonly #memory: WebAssembly.Memory
    readonly #engine: EngineExports
    readonly #sampleRate: number
    #bound: boolean = false
    #sinceStats: number = 0
    #sinceState: number = 0

    constructor(options?: AudioWorkletNodeOptions) {
        super()
        const {engineModule, instrumentModule, sampleRate, metronome}: BootOptions = options?.processorOptions
        this.#sampleRate = sampleRate
        // one shared linear memory: 256 pages (16 MiB) initial, growable (talc grows it on demand).
        this.#memory = new WebAssembly.Memory({initial: 256})
        const env = {memory: this.#memory}
        // the device plugin first (the engine imports its `process` / `state_size`); the engine instance
        // retains the device through that import binding, so no separate reference is kept here.
        const instrument = new WebAssembly.Instance(instrumentModule, {env}).exports as unknown as InstrumentExports
        this.#engine = new WebAssembly.Instance(engineModule, {
            env,
            instrument: {process: instrument.process, state_size: instrument.state_size}
        }).exports as unknown as EngineExports
        this.#engine.init(sampleRate)
        // relocate the device's stack into an engine-allocated block, then init the device.
        instrument.__stack_pointer.value = this.#engine.setup_device()
        instrument.init(sampleRate)
        if (metronome === false) {this.#engine.set_metronome_enabled(0)}
        this.port.onmessage = (event: MessageEvent) => this.#applyUpdates(event.data as ArrayBuffer)
    }

    #applyUpdates(bytes: ArrayBuffer): void {
        const array = new Uint8Array(bytes)
        if (array.length > this.#engine.input_capacity()) {return}
        new Uint8Array(this.#memory.buffer, this.#engine.input_ptr(), array.length).set(array)
        this.#engine.apply_updates(array.length)
        if (!this.#bound && this.#engine.bind() === 0) {this.#bound = true}
    }

    process(_inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean {
        const out = outputs[0]
        if (out.length === 0) {return true}
        this.#engine.render()
        const frames = out[0].length // the render quantum (128)
        const buffer = this.#memory.buffer // re-read each block: talc may have grown (detached) the buffer
        const pointer = this.#engine.output_ptr()
        const left = new Float32Array(buffer, pointer, frames)
        const right = new Float32Array(buffer, pointer + frames * Float32Array.BYTES_PER_ELEMENT, frames)
        out[0].set(left)
        if (out.length > 1) {out[1].set(right)}
        this.#sinceState += frames
        if (this.#sinceState >= this.#sampleRate / 30) { // ~30 Hz transport-state back-channel
            this.#sinceState = 0
            const length = this.#engine.engine_state_len()
            const bytes = new Uint8Array(buffer, this.#engine.engine_state_ptr(), length).slice().buffer
            this.port.postMessage({type: "state", bytes}, [bytes])
        }
        this.#sinceStats += frames
        if (this.#sinceStats >= this.#sampleRate) { // ~once per second of audio
            this.#sinceStats = 0
            this.port.postMessage({
                type: "heap",
                heapUsed: this.#engine.heap_used(),
                heapClaimed: this.#engine.heap_claimed(),
                memoryTotal: this.#memory.buffer.byteLength
            })
        }
        return true
    }
}

registerProcessor("engine", EngineProcessor)

export {} // isolate this file's module scope from other worklets
