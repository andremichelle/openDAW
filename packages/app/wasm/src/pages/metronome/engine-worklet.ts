// Runs the engine wasm on the audio thread. The engine is the dynamic-linker host: it owns the ONE shared
// linear memory + function table, and loads each device as a PIC SIDE MODULE at a host-assigned base. The
// loader here (per device) reads its `dylink.0`, allocates its data region + stack from the engine's talc
// (device_alloc), sets the device's imported __memory_base / __table_base / __stack_pointer, applies its
// data relocations, installs its `process` into the shared table, and registers it (device_register). The
// engine then calls each device via call_indirect on that table slot — wasm-to-wasm, zero copy. So any
// number of distinct device modules coexist in the one memory with no fixed addresses.
//
// The engine holds the wasm BoxGraph mirror; the main thread serializes SyncSource's UpdateTask[] into
// bytes and posts them here. Each batch -> apply_updates, then bind() once the TimelineBox exists.

const ENGINE_TABLE_RESERVE = 512 // shared table slots reserved for the engine's own functions (it needs ~42)
const DEVICE_STACK_SIZE = 256 * 1024 // talc-allocated stack handed to each loaded device

type BootOptions = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module> // PIC side modules, in load order (device 0, 1, ...)
    memory: WebAssembly.Memory // SHARED, created on the main thread so it can see the WASM heap
    sampleRate: number
    metronome?: boolean // default true; the note's page sets false to hear only the instrument
}

// The device exports the loader touches. `state_size` takes the sample rate (devices size their state
// from it, e.g. a delay buffer), so the device holds no global rate. Relocation helpers are optional.
type DeviceExports = {
    process: (descPtr: number) => void
    state_size: (sampleRate: number) => number
    __wasm_apply_data_relocs?: () => void
    __wasm_call_ctors?: () => void
}

type EngineExports = {
    init: (sampleRate: number) => void
    device_alloc: (size: number) => number
    device_register: (processIndex: number, stateSize: number) => number
    input_ptr: () => number
    input_capacity: () => number
    input_reserve: (len: number) => number // ensure the input scratch holds `len`, grow if needed, return its (current) ptr
    apply_updates: (len: number) => number
    bind: () => number
    render: () => void
    output_ptr: () => number
    heap_used: () => number
    heap_claimed: () => number
    engine_state_ptr: () => number
    engine_state_len: () => number
    set_metronome_enabled: (enabled: number) => void
    // A device imports this from `env`; the loader binds it so the device PULLS its own input events for a
    // pulse range (Route A), writing EventRecords into the descriptor scratch and returning the count.
    host_pull_events: (from: number, to: number, flags: number, outPtr: number, max: number) => number
}

// Read a varuint32 (LEB128) at `pos`; returns [value, nextPos].
const readVarU32 = (bytes: Uint8Array, pos: number): [number, number] => {
    let result = 0
    let shift = 0
    let cursor = pos
    for (; ;) {
        const byte = bytes[cursor++]
        result |= (byte & 0x7f) << shift
        if ((byte & 0x80) === 0) {break}
        shift += 7
    }
    return [result >>> 0, cursor]
}

// Parse a device's `dylink.0` section for the WASM_DYLINK_MEM_INFO sizes the loader needs.
const parseDylink = (module: WebAssembly.Module): { memorySize: number, tableSize: number } => {
    const sections = WebAssembly.Module.customSections(module, "dylink.0")
    if (sections.length === 0) {return {memorySize: 0, tableSize: 0}}
    const bytes = new Uint8Array(sections[0])
    let pos = 0
    while (pos < bytes.length) {
        const type = bytes[pos++]
        const [size, afterSize] = readVarU32(bytes, pos)
        if (type === 1) { // WASM_DYLINK_MEM_INFO: memorysize, memoryalignment, tablesize, tablealignment
            const [memorySize, afterMem] = readVarU32(bytes, afterSize)
            const [, afterAlign] = readVarU32(bytes, afterMem)
            const [tableSize] = readVarU32(bytes, afterAlign)
            return {memorySize, tableSize}
        }
        pos = afterSize + size
    }
    return {memorySize: 0, tableSize: 0}
}

class EngineProcessor extends AudioWorkletProcessor {
    readonly #memory: WebAssembly.Memory
    readonly #engine: EngineExports
    readonly #table: WebAssembly.Table
    readonly #sampleRate: number
    #bound: boolean = false
    #sinceStats: number = 0
    #sinceState: number = 0

    constructor(options?: AudioWorkletNodeOptions) {
        super()
        const {engineModule, deviceModules, memory, sampleRate, metronome}: BootOptions = options?.processorOptions
        this.#sampleRate = sampleRate
        // the one SHARED linear memory, created on the main thread and handed in (so the main thread can
        // see the WASM heap). talc grows it on demand; shared memory grows in place without detaching.
        this.#memory = memory
        // the one shared function table: the engine (main module) imports it and uses the low slots; each
        // device's functions + its `process` entry are appended above via table.grow.
        this.#table = new WebAssembly.Table({initial: ENGINE_TABLE_RESERVE, element: "anyfunc"})
        const env = {memory, __indirect_function_table: this.#table}
        // the engine is the dynamic-linker host; instantiate it first, before any device.
        const engine = new WebAssembly.Instance(engineModule, {env}).exports as unknown as EngineExports
        this.#engine = engine
        engine.init(sampleRate)
        // load each device PIC side module at a host-assigned base and register it with the engine.
        for (const deviceModule of deviceModules) {this.#loadDevice(deviceModule, sampleRate)}
        if (metronome === false) {engine.set_metronome_enabled(0)}
        this.port.onmessage = (event: MessageEvent) => this.#applyUpdates(event.data as ArrayBuffer)
    }

    // Link one PIC device side module into the engine: assign it memory + table + stack bases from talc,
    // instantiate, apply its data relocations, install its `process` into the shared table, and register.
    #loadDevice(module: WebAssembly.Module, sampleRate: number): void {
        const engine = this.#engine
        const table = this.#table
        const {memorySize, tableSize} = parseDylink(module)
        const memoryBase = engine.device_alloc(memorySize)
        const tableBase = tableSize > 0 ? table.grow(tableSize) : table.length
        const stackBase = engine.device_alloc(DEVICE_STACK_SIZE)
        const device = new WebAssembly.Instance(module, {
            env: {
                memory: this.#memory,
                __indirect_function_table: table,
                __memory_base: new WebAssembly.Global({value: "i32", mutable: false}, memoryBase),
                __table_base: new WebAssembly.Global({value: "i32", mutable: false}, tableBase),
                __stack_pointer: new WebAssembly.Global({value: "i32", mutable: true}, stackBase + DEVICE_STACK_SIZE),
                // wasm-to-wasm: the device calls the engine's event-pull export directly (Route A).
                host_pull_events: engine.host_pull_events
            }
        }).exports as unknown as DeviceExports
        device.__wasm_apply_data_relocs?.()
        device.__wasm_call_ctors?.()
        // The sample rate is known at load (the earliest point), so the device sizes its state from it
        // here (e.g. a delay buffer) and reads it per render from the descriptor — no device-global rate.
        const processIndex = table.grow(1) // a fresh slot for the engine -> device call_indirect
        table.set(processIndex, device.process as unknown as () => void)
        engine.device_register(processIndex, device.state_size(sampleRate))
    }

    #applyUpdates(bytes: ArrayBuffer): void {
        const array = new Uint8Array(bytes)
        // ensure the engine's input scratch holds this transaction, growing it if needed (kept at the
        // high-water mark). The returned pointer is current even if a grow moved the buffer. So a large
        // transaction is never silently dropped (which would desync the engine's box graph).
        const pointer = this.#engine.input_reserve(array.length)
        new Uint8Array(this.#memory.buffer, pointer, array.length).set(array)
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
