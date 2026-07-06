// The ONE owner of the device side-module linking ritual, shared by the worklet (engine-processor.ts), the
// perf worker (perf/offline-render.ts), and the test loader (test/helpers/load-full-engine.ts). Everything a
// device needs to join the engine lives here: the `dylink.0` parse, the talc base/stack allocation, the env
// (including the SINGLE authoritative host-import list), relocations, table installation, registration, and
// the box-type / composite name mapping. A new engine export added here reaches every context at once; a
// loader that misses one fails LOUDLY at link time with the import's name instead of a cryptic LinkError.

export const DEVICE_STACK_SIZE = 256 * 1024 // talc-allocated stack handed to each loaded device

export type BridgeImports = Record<string, (...args: Array<number>) => number | void>

// The engine exports a device side-module imports from `env` (wasm-to-wasm via the loader binding). This
// list is the CONTRACT: extend it here when the engine gains a host export, never in a loader.
const HOST_IMPORTS: ReadonlyArray<string> = [
    "host_pull_events", "host_pulse_to_offset",
    "host_bind_parameter", "host_bind_broadcast", "host_broadcast_ptr", "host_broadcast_active",
    "host_update_parameters", "host_first_update_position", "host_next_update_position",
    "host_resolve_sample", "host_observe_sample",
    "host_resolve_soundfont", "host_observe_soundfont",
    "host_observe_field", "host_observe_target_string",
    "host_bind_sidechain", "host_resolve_input", "host_self_uuid", "host_panic"
]

// The device exports the linker touches. `state_size` takes the sample rate (devices size their state from
// it), so the device holds no global rate. Relocation helpers are optional.
export type DeviceExports = {
    process?: (descPtr: number) => void
    process_events?: (from: number, to: number, flags: number, statePtr: number, outPtr: number, max: number) => number
    state_size: (sampleRate: number) => number
    kind: () => number
    init?: (statePtr: number, sampleRate: number) => void
    parameter_changed?: (statePtr: number, id: number, kind: number, value: number) => void
    field_changed?: (statePtr: number, id: number, kind: number, bits: number, len: number) => void
    sample_changed?: (statePtr: number, id: number, handle: number, present: number) => void
    soundfont_changed?: (statePtr: number, id: number, handle: number, present: number) => void
    reset?: (statePtr: number) => void
    midi_effects_field?: () => number
    audio_effects_field?: () => number
    observe_param_collection_field?: () => number
    observe_sample_collection_field?: () => number
    __wasm_apply_data_relocs?: () => void
    __wasm_call_ctors?: () => void
}

// The engine exports the LINKER calls (each loader's own EngineExports type is a superset).
export type LinkerEngine = {
    device_alloc: (size: number) => number
    device_register: (processIndex: number, stateSize: number, kind: number, initIndex: number,
                      parameterChangedIndex: number, fieldChangedIndex: number, sampleChangedIndex: number,
                      soundfontChangedIndex: number, resetIndex: number, midiEffectsField: number,
                      audioEffectsField: number, paramCollectionField: number, sampleCollectionField: number) => number
    device_set_box_type: (deviceId: number, nameLen: number) => void
    composite_register: (nameLen: number, childrenField: number, indexKey: number, excludeKey: number,
                         cellInstrumentField: number, cellMidiField: number, cellAudioField: number,
                         childEnabledKey: number, childMuteKey: number, childSoloKey: number) => void
    input_reserve: (len: number) => number
}

export type CompositeRegistration = {
    boxType: string, childrenField: number, indexKey: number, excludeKey: number,
    cellInstrumentField: number, cellMidiField: number, cellAudioField: number,
    childEnabledKey: number, childMuteKey: number, childSoloKey: number
}

const readVarU32 = (bytes: Uint8Array, pos: number): [number, number] => {
    let result = 0, shift = 0, cursor = pos
    for (; ;) {
        const byte = bytes[cursor++]
        result |= (byte & 0x7f) << shift
        if ((byte & 0x80) === 0) {break}
        shift += 7
    }
    return [result >>> 0, cursor]
}

// Read a PIC side module's memory/table requirements from its `dylink.0` custom section.
export const parseDylink = (module: WebAssembly.Module): {memorySize: number, tableSize: number} => {
    const sections = WebAssembly.Module.customSections(module, "dylink.0")
    if (sections.length === 0) {return {memorySize: 0, tableSize: 0}}
    const bytes = new Uint8Array(sections[0])
    let pos = 0
    while (pos < bytes.length) {
        const type = bytes[pos++]
        const [size, afterSize] = readVarU32(bytes, pos)
        if (type === 1) {
            const [memorySize, afterMem] = readVarU32(bytes, afterSize)
            const [, afterAlign] = readVarU32(bytes, afterMem)
            const [tableSize] = readVarU32(bytes, afterAlign)
            return {memorySize, tableSize}
        }
        pos = afterSize + size
    }
    return {memorySize: 0, tableSize: 0}
}

// Write an ASCII box-type name into the engine's input scratch (no TextEncoder in the worklet scope).
const writeName = (engine: LinkerEngine, memory: WebAssembly.Memory, name: string): number => {
    const length = name.length
    const pointer = engine.input_reserve(length)
    const bytes = new Uint8Array(memory.buffer, pointer, length)
    for (let index = 0; index < length; index++) {bytes[index] = name.charCodeAt(index) & 0xff}
    return length
}

// Link ONE device PIC side module into the engine: assign it memory + table + stack bases from talc,
// instantiate with the authoritative host imports plus the JS bridge closures, apply its relocations,
// install its `process` (or MIDI-fx `process_events`) into the shared table, install the optional hooks,
// register it, and map its device-box type.
export const linkDevice = (engine: LinkerEngine, memory: WebAssembly.Memory, table: WebAssembly.Table,
                           module: WebAssembly.Module, boxType: string, sampleRate: number,
                           bridgeImports: BridgeImports): void => {
    const {memorySize, tableSize} = parseDylink(module)
    const memoryBase = engine.device_alloc(memorySize)
    const tableBase = tableSize > 0 ? table.grow(tableSize) : table.length
    const stackBase = engine.device_alloc(DEVICE_STACK_SIZE)
    const env: Record<string, unknown> = {
        memory, __indirect_function_table: table,
        __memory_base: new WebAssembly.Global({value: "i32", mutable: false}, memoryBase),
        __table_base: new WebAssembly.Global({value: "i32", mutable: false}, tableBase),
        __stack_pointer: new WebAssembly.Global({value: "i32", mutable: true}, stackBase + DEVICE_STACK_SIZE)
    }
    for (const name of HOST_IMPORTS) {
        const fn = (engine as unknown as Record<string, unknown>)[name]
        if (typeof fn !== "function") {throw new Error(`engine is missing the device host export '${name}'`)}
        env[name] = fn
    }
    Object.assign(env, bridgeImports)
    const device = new WebAssembly.Instance(module, {env: env as WebAssembly.ModuleImports}).exports as unknown as DeviceExports
    device.__wasm_apply_data_relocs?.()
    device.__wasm_call_ctors?.()
    // Install an optional device export into a fresh table slot, 0 = "none" (device slots are grown above
    // the engine's own table functions, so a real hook is never at 0).
    const installOptional = (fn: ((...args: Array<number>) => unknown) | undefined): number => {
        if (fn === undefined) {return 0}
        const index = table.grow(1)
        table.set(index, fn as unknown as () => void)
        return index
    }
    // An audio device installs `process`; a MIDI-fx device installs `process_events` (its pull responder).
    const processIndex = table.grow(1)
    table.set(processIndex, (device.process_events ?? device.process) as unknown as () => void)
    const deviceId = engine.device_register(
        processIndex, device.state_size(sampleRate), device.kind(),
        installOptional(device.init), installOptional(device.parameter_changed),
        installOptional(device.field_changed), installOptional(device.sample_changed),
        installOptional(device.soundfont_changed), installOptional(device.reset),
        device.midi_effects_field?.() ?? 0, device.audio_effects_field?.() ?? 0,
        device.observe_param_collection_field?.() ?? 0, device.observe_sample_collection_field?.() ?? 0)
    engine.device_set_box_type(deviceId, writeName(engine, memory, boxType))
}

// Register one COMPOSITE box type (a box hosting a child collection of its own instruments): write its
// name, then map its child collection fields. The child plugin itself is a normal `linkDevice` entry.
export const registerComposite = (engine: LinkerEngine, memory: WebAssembly.Memory, spec: CompositeRegistration): void => {
    engine.composite_register(writeName(engine, memory, spec.boxType), spec.childrenField, spec.indexKey,
        spec.excludeKey, spec.cellInstrumentField, spec.cellMidiField, spec.cellAudioField, spec.childEnabledKey,
        spec.childMuteKey, spec.childSoloKey)
}
