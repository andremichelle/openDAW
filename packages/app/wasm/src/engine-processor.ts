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

import {UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {CompositeSpec} from "./engine-modules"
import {SampleInfo, SampleLoader} from "./sample-loader"
import {SoundfontInfo, SoundfontLoader} from "./soundfont-loader"
import {EngineProtocol, HeapListener, HeapStats, ScriptListener, TransportListener} from "./engine-protocol"
import {ScriptBridges, ScriptEngine} from "./script-bridge"

const ENGINE_TABLE_RESERVE = 512 // shared table slots reserved for the engine's own functions (it needs ~42)
const DEVICE_STACK_SIZE = 256 * 1024 // talc-allocated stack handed to each loaded device

type BootOptions = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module> // PIC side modules, in load order (device 0, 1, ...)
    deviceBoxTypes: ReadonlyArray<string> // parallel to deviceModules: the device-box type each plugin realizes
    composites: ReadonlyArray<CompositeSpec> // composite box types the engine hosts as child collections
    memory: WebAssembly.Memory // SHARED, created on the main thread so it can see the WASM heap
    sampleRate: number
    metronome?: boolean // default true; the note's page sets false to hear only the instrument
}

// The device exports the loader touches. `state_size` takes the sample rate (devices size their state
// from it, e.g. a delay buffer), so the device holds no global rate. Relocation helpers are optional.
type DeviceExports = {
    process?: (descPtr: number) => void // audio devices (instrument / effect): called once per quantum
    // MIDI-fx devices: a pull responder invoked when something downstream pulls them for [from, to)
    process_events?: (from: number, to: number, flags: number, statePtr: number, outPtr: number, max: number) => number
    state_size: (sampleRate: number) => number
    kind: () => number // DEVICE_KIND_INSTRUMENT (0) / EFFECT (1) / MIDI_EFFECT (2); tells the host how to wire it
    // Route D parameter hooks (optional): `init` binds the device's parameters with the host; the engine
    // calls `parameter_changed` to push a resolved value (initial / edit / automation). `kind` tags how the
    // f32 `value` is read (uniform 0..1 to map, or a real int / float / bool field value). Engine calls these
    // wasm-to-wasm through the shared table; JS only installs the function pointers, never invokes them.
    init?: (statePtr: number, sampleRate: number) => void
    parameter_changed?: (statePtr: number, id: number, kind: number, value: number) => void
    field_changed?: (statePtr: number, id: number, kind: number, bits: number, len: number) => void
    sample_changed?: (statePtr: number, id: number, handle: number, present: number) => void
    soundfont_changed?: (statePtr: number, id: number, handle: number, present: number) => void
    reset?: (statePtr: number) => void
    // The box field keys hosting this device's OWN midi / audio fx chains when it runs as a composite child
    // (e.g. a Playfield slot). Absent / 0 means the device hosts no chains of its own.
    midi_effects_field?: () => number
    audio_effects_field?: () => number
    // Scriptable devices (Werkstatt / Apparat / Spielwerk): the collection field keys whose child boxes the
    // engine observes as the device's dynamic @param / @sample declarations (11 / 12). Absent / 0 = none.
    observe_param_collection_field?: () => number
    observe_sample_collection_field?: () => number
    __wasm_apply_data_relocs?: () => void
    __wasm_call_ctors?: () => void
}

type EngineExports = {
    init: (sampleRate: number) => void
    device_alloc: (size: number) => number
    device_register: (processIndex: number, stateSize: number, kind: number, initIndex: number, parameterChangedIndex: number, fieldChangedIndex: number, sampleChangedIndex: number, soundfontChangedIndex: number, resetIndex: number, midiEffectsField: number, audioEffectsField: number, paramCollectionField: number, sampleCollectionField: number) => number
    // Map a device-box type to the just-registered device: the box-type UTF-8 name is written into the
    // input buffer (nameLen bytes) first. This is the device table the engine instantiates boxes through.
    device_set_box_type: (deviceId: number, nameLen: number) => void
    // Register a composite box type (a box hosting a child collection of its own instruments): the composite
    // box-type UTF-8 name is written into the input buffer (nameLen bytes) first, then its child collection's
    // host field key + the child index/routing key are passed. Mirrors device_set_box_type.
    composite_register: (nameLen: number, childrenField: number, indexKey: number, excludeKey: number, cellInstrumentField: number, cellMidiField: number, cellAudioField: number, childEnabledKey: number) => void
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
    // Transport: `play` starts advancing, `pause` freezes (state kept), `stop` rewinds to 0 + resets all plugins.
    play: () => void
    pause: () => void
    stop: () => void
    // A device imports this from `env`; the loader binds it so the device PULLS its own input events for a
    // pulse range (Route A), writing EventRecords into the descriptor scratch and returning the count.
    host_pull_events: (from: number, to: number, flags: number, outPtr: number, max: number) => number
    // Maps a pulse position to its sample offset in the current quantum; a generative device (arp) times
    // its emitted events with it.
    host_pulse_to_offset: (pulse: number) => number
    // Route D parameter hooks. `host_bind_parameter` registers a parameter by its field-key path (a u16
    // slice in the device's memory) from `init`, returning its id (the host is mapping-agnostic — the device
    // maps). `host_update_parameters` pulls the device's parameters that changed at a position into a
    // ParamChange scratch, returning the count. `host_next_update_position` returns the next update-clock
    // position after a pulse (or +Infinity when the device has no automation), so the render fragments at it.
    host_bind_parameter: (pathPtr: number, pathLen: number) => number
    host_update_parameters: (position: number, outPtr: number, max: number) => number
    host_first_update_position: (at: number) => number
    host_next_update_position: (after: number) => number
    // Route F (samples). A device imports `host_resolve_sample` from `env` to resolve a sample handle to its
    // resident frames during render. The other three are the off-render load handshake the worklet drives:
    // `sample_take_request` pops a queued load (writing its 16-byte uuid to outPtr, returning the handle or
    // -1), `sample_allocate` reserves the decoded byte length and returns the pointer, `sample_set_ready`
    // marks it resolvable once the frames are written.
    host_resolve_sample: (handle: number, outPtr: number) => number
    host_resolve_soundfont: (handle: number, outPtr: number) => number
    host_observe_soundfont: (pathPtr: number, pathLen: number) => number
    soundfont_take_request: (outPtr: number) => number
    soundfont_allocate: (handle: number, byteLength: number) => number
    soundfont_set_ready: (handle: number) => void
    // A scriptable device imports this from `env`; the engine writes the current device box's 16 uuid bytes to
    // `outPtr` (called from the device's `init`), so the script bridge can key its registry lookup by uuid.
    host_self_uuid: (outPtr: number) => void
    host_observe_sample: (pathPtr: number, pathLen: number) => number
    host_observe_field: (pathPtr: number, pathLen: number) => number
    // Route B/C (audio input ports). A device imports these: `host_bind_sidechain` declares a sidechain port by
    // its pointer field-key path (returns the port id 2+); `host_resolve_input` resolves a port id to its
    // stereo buffer during render (id 1 the through-signal).
    host_bind_sidechain: (pathPtr: number, pathLen: number) => number
    host_resolve_input: (id: number, outPtr: number) => number
    sample_take_request: (outPtr: number) => number
    sample_allocate: (handle: number, byteLength: number) => number
    sample_set_ready: (handle: number, frameCount: number, channelCount: number, sampleRate: number) => void
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
    #transport!: TransportListener // transport-state back-channel sender (set in the constructor)
    #heap!: HeapListener // heap-stats back-channel sender (set in the constructor)
    #loader!: SampleLoader // the sample-load RPC sender (set in the constructor)
    #soundfontLoader!: SoundfontLoader // the soundfont-load RPC sender (set in the constructor)
    #scripts!: ScriptListener // scriptable-device error back-channel sender (set in the constructor)
    readonly #scriptBridges: ScriptBridges // runs the scriptable devices' user JS over the shared memory

    constructor(options?: AudioWorkletNodeOptions) {
        super()
        const {engineModule, deviceModules, deviceBoxTypes, composites, memory, sampleRate, metronome}: BootOptions = options?.processorOptions
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
        // The script bridge runs the scriptable devices' user JavaScript over the shared memory; its `host_script_*`
        // closures are bound into each scriptable device's env at load. A user-script error reports out on the
        // `script` back-channel (set up below; the closure runs only during render, by which point it is wired).
        this.#scriptBridges = new ScriptBridges(memory, engine as unknown as ScriptEngine, sampleRate,
            (uuid, message) => this.#scripts.deviceMessage(uuid, message))
        const scriptImports = this.#scriptBridges.imports()
        // load each device PIC side module at a host-assigned base, register it, and map its box type.
        deviceModules.forEach((deviceModule, index) => this.#loadDevice(deviceModule, deviceBoxTypes[index], sampleRate, scriptImports))
        // register each composite box type: write its name into the input buffer, then map its child collection
        // (the child plugin itself is a normal device above). Box-type names are ASCII identifiers.
        composites.forEach(({boxType, childrenField, indexKey, excludeKey, cellInstrumentField, cellMidiField, cellAudioField, childEnabledKey}) => {
            const length = boxType.length
            const pointer = engine.input_reserve(length)
            const bytes = new Uint8Array(this.#memory.buffer, pointer, length)
            for (let index = 0; index < length; index++) {bytes[index] = boxType.charCodeAt(index) & 0xff}
            engine.composite_register(length, childrenField, indexKey, excludeKey, cellInstrumentField, cellMidiField, cellAudioField, childEnabledKey)
        })
        if (metronome === false) {engine.set_metronome_enabled(0)}
        // ONE Messenger over the engine port, split into typed Communicator protocols, one per named channel
        // (each channel is a single sender -> executor direction): `engine` receives the SyncSource transaction
        // bytes (this side EXECUTES), `transport` / `heap` push the back-channels out (this side SENDS), and
        // `samples` drives the sample-load RPC (this side SENDS). The senders are set up here, so they are ready
        // before any transport-state tick or AudioFileBox load.
        const processor = this
        const messenger = Messenger.for(this.port)
        Communicator.executor<EngineProtocol>(messenger.channel("engine"), new class implements EngineProtocol {
            applyUpdates(bytes: ArrayBuffer): void {processor.#applyUpdates(bytes)}
            play(): void {processor.#engine?.play()}
            pause(): void {processor.#engine?.pause()}
            stop(): void {processor.#engine?.stop()}
        })
        this.#transport = Communicator.sender<TransportListener>(messenger.channel("transport"), dispatcher => new class implements TransportListener {
            state(bytes: ArrayBuffer): void {dispatcher.dispatchAndForget(this.state, Communicator.makeTransferable(bytes))}
        })
        this.#heap = Communicator.sender<HeapListener>(messenger.channel("heap"), dispatcher => new class implements HeapListener {
            heap(stats: HeapStats): void {dispatcher.dispatchAndForget(this.heap, stats)}
        })
        this.#loader = Communicator.sender<SampleLoader>(messenger.channel("samples"), dispatcher => new class implements SampleLoader {
            decode(uuid: UUID.Bytes): Promise<SampleInfo> {return dispatcher.dispatchAndReturn(this.decode, uuid)}
            write(uuid: UUID.Bytes, pointer: number): Promise<void> {return dispatcher.dispatchAndReturn(this.write, uuid, pointer)}
        })
        this.#soundfontLoader = Communicator.sender<SoundfontLoader>(messenger.channel("soundfonts"), dispatcher => new class implements SoundfontLoader {
            decode(uuid: UUID.Bytes): Promise<SoundfontInfo> {return dispatcher.dispatchAndReturn(this.decode, uuid)}
            write(uuid: UUID.Bytes, pointer: number): Promise<void> {return dispatcher.dispatchAndReturn(this.write, uuid, pointer)}
        })
        this.#scripts = Communicator.sender<ScriptListener>(messenger.channel("script"), dispatcher => new class implements ScriptListener {
            deviceMessage(uuid: string, message: string): void {dispatcher.dispatchAndForget(this.deviceMessage, uuid, message)}
        })
    }

    // Pop every sample the engine queued (on seeing an AudioFileBox) and run the load handshake for each:
    // decode (main fetches + decodes, reports the size), allocate the engine storage, write the planar frames
    // into the SAB, mark ready. Each runs as its own async chain off the render path; a wrong sample never
    // blocks the others. The 16-byte uuid is copied out of the (reused) input scratch BEFORE any await.
    #drainSampleRequests(): void {
        const loader = this.#loader
        for (; ;) {
            const outPtr = this.#engine.input_reserve(16)
            const handle = this.#engine.sample_take_request(outPtr)
            if (handle < 0) {break}
            const uuid = new Uint8Array(this.#memory.buffer, outPtr, 16).slice()
            void (async () => {
                const info = await loader.decode(uuid)
                const pointer = this.#engine.sample_allocate(handle, info.byteLength)
                await loader.write(uuid, pointer)
                this.#engine.sample_set_ready(handle, info.frameCount, info.channelCount, info.sampleRate)
            })()
        }
    }

    // The soundfont analog of `#drainSampleRequests`: the main-thread loader parses the .sf2 + builds the
    // simplified blob, reports its size, and writes it into the engine allocation. Each request runs as its own
    // async chain so a slow/failed soundfont never blocks others.
    #drainSoundfontRequests(): void {
        const loader = this.#soundfontLoader
        for (; ;) {
            const outPtr = this.#engine.input_reserve(16)
            const handle = this.#engine.soundfont_take_request(outPtr)
            if (handle < 0) {break}
            const uuid = new Uint8Array(this.#memory.buffer, outPtr, 16).slice()
            void (async () => {
                const info = await loader.decode(uuid)
                const pointer = this.#engine.soundfont_allocate(handle, info.byteLength)
                await loader.write(uuid, pointer)
                this.#engine.soundfont_set_ready(handle)
            })()
        }
    }

    // Link one PIC device side module into the engine: assign it memory + table + stack bases from talc,
    // instantiate, apply its data relocations, install its `process` into the shared table, register it, and
    // map its device-box type to the registered device id (the engine's device table).
    #loadDevice(module: WebAssembly.Module, boxType: string, sampleRate: number,
                scriptImports: Record<string, (...args: Array<number>) => number | void>): void {
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
                // wasm-to-wasm: the device calls the engine's event-pull / timing / parameter exports
                // directly (Route A pull + Route D parameters).
                host_pull_events: engine.host_pull_events,
                host_pulse_to_offset: engine.host_pulse_to_offset,
                host_bind_parameter: engine.host_bind_parameter,
                host_update_parameters: engine.host_update_parameters,
                host_first_update_position: engine.host_first_update_position,
                host_next_update_position: engine.host_next_update_position,
                // Route F: the device resolves a sample handle to its frames during render, and declares its
                // sample reference (its box file-pointer path) from `init`.
                host_resolve_sample: engine.host_resolve_sample,
                host_observe_sample: engine.host_observe_sample,
                // Soundfont: the device resolves its simplified blob during render and declares its `file`
                // pointer from `init`, mirroring the sample surface.
                host_resolve_soundfont: engine.host_resolve_soundfont,
                host_observe_soundfont: engine.host_observe_soundfont,
                host_observe_field: engine.host_observe_field,
                host_bind_sidechain: engine.host_bind_sidechain,
                host_resolve_input: engine.host_resolve_input,
                // Scriptable devices: the engine's self-uuid export + the JS script bridge closures.
                host_self_uuid: engine.host_self_uuid,
                ...scriptImports
            }
        }).exports as unknown as DeviceExports
        device.__wasm_apply_data_relocs?.()
        device.__wasm_call_ctors?.()
        // The sample rate is known at load (the earliest point), so the device sizes its state from it
        // here (e.g. a delay buffer) and reads it per render from the descriptor — no device-global rate.
        const processIndex = table.grow(1) // a fresh slot for the engine -> device call_indirect
        // An audio device installs `process`; a MIDI-fx device installs `process_events` (its pull responder).
        const entry = device.process_events ?? device.process
        table.set(processIndex, entry as unknown as () => void)
        // Route D: install the parameter hooks into the table if the device has them (index 0 = none — device
        // slots are grown above the engine's own functions, so a real hook is never at 0).
        const initIndex = this.#installOptional(device.init)
        const parameterChangedIndex = this.#installOptional(device.parameter_changed)
        const fieldChangedIndex = this.#installOptional(device.field_changed)
        const sampleChangedIndex = this.#installOptional(device.sample_changed)
        const soundfontChangedIndex = this.#installOptional(device.soundfont_changed)
        const resetIndex = this.#installOptional(device.reset)
        // These are plain field-key VALUES the device returns (like kind()), not table slots: call directly,
        // defaulting to 0 when the device hosts no fx chains of its own.
        const midiEffectsField = device.midi_effects_field?.() ?? 0
        const audioEffectsField = device.audio_effects_field?.() ?? 0
        const paramCollectionField = device.observe_param_collection_field?.() ?? 0
        const sampleCollectionField = device.observe_sample_collection_field?.() ?? 0
        const deviceId = engine.device_register(processIndex, device.state_size(sampleRate), device.kind(), initIndex, parameterChangedIndex, fieldChangedIndex, sampleChangedIndex, soundfontChangedIndex, resetIndex, midiEffectsField, audioEffectsField, paramCollectionField, sampleCollectionField)
        // Register the device table entry: write the box-type name into the input buffer, then map it.
        // Box-type names are ASCII identifiers, so encode byte-per-char (no TextEncoder in the worklet scope).
        const length = boxType.length
        const pointer = engine.input_reserve(length)
        const bytes = new Uint8Array(this.#memory.buffer, pointer, length)
        for (let index = 0; index < length; index++) {bytes[index] = boxType.charCodeAt(index) & 0xff}
        engine.device_set_box_type(deviceId, length)
    }

    // Install an optional device export into a fresh table slot and return its index, or 0 ("none") when the
    // device does not export it. Device slots are grown above the engine's own table functions, so 0 is never
    // a real device hook.
    #installOptional(fn: ((...args: Array<number>) => unknown) | undefined): number {
        if (fn === undefined) {return 0}
        const index = this.#table.grow(1)
        this.#table.set(index, fn as unknown as () => void)
        return index
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
        // A transaction may have added AudioFileBoxes (the engine queued their loads); dispatch them.
        this.#drainSampleRequests()
        // Likewise a SoundfontFileBox target queues a soundfont blob build; dispatch those too.
        this.#drainSoundfontRequests()
        // Emit heap stats off-render so the panel updates while the context is suspended (a scrub never
        // calls `process`); a delete that frees a sample is then visible as Heap-used dropping at once.
        this.#heap.heap({
            heapUsed: this.#engine.heap_used(),
            heapClaimed: this.#engine.heap_claimed(),
            memoryTotal: this.#memory.buffer.byteLength
        })
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
            this.#transport.state(bytes)
        }
        this.#sinceStats += frames
        if (this.#sinceStats >= this.#sampleRate) { // ~once per second of audio
            this.#sinceStats = 0
            this.#heap.heap({
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
