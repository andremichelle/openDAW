// Loads the REAL engine.wasm AND every device side-module (delay, gate, vaporisateur, playfield slot, …) the
// same way the AudioWorklet does (engine-processor.ts), so a test can drive the actual DSP graph — not the
// bare engine with an empty device table. Reuse this for any test that needs real devices / composites.

import * as path from "node:path"
import {readFileSync} from "node:fs"

const PUBLIC = path.resolve(__dirname, "../../public")
const DEVICE_STACK_SIZE = 256 * 1024

// Parallel to engine-modules.ts DEVICES / COMPOSITES.
const DEVICES: ReadonlyArray<{file: string, boxType: string}> = [
    {file: "device_vaporisateur.wasm", boxType: "VaporisateurDeviceBox"},
    {file: "device_nano.wasm", boxType: "NanoDeviceBox"},
    {file: "device_lowpass.wasm", boxType: "RevampDeviceBox"},
    {file: "device_tidal.wasm", boxType: "TidalDeviceBox"},
    {file: "device_delay.wasm", boxType: "DelayDeviceBox"},
    {file: "device_gate.wasm", boxType: "GateDeviceBox"},
    {file: "device_arp.wasm", boxType: "ArpeggioDeviceBox"},
    {file: "device_zeitgeist.wasm", boxType: "ZeitgeistDeviceBox"},
    {file: "device_transpose.wasm", boxType: "PitchDeviceBox"},
    {file: "device_playfield_slot.wasm", boxType: "PlayfieldSampleBox"}
]
type CompositeSpec = {boxType: string, childrenField: number, indexKey: number, excludeKey: number,
    cellInstrumentField: number, cellMidiField: number, cellAudioField: number}
const COMPOSITES: ReadonlyArray<CompositeSpec> = [
    {boxType: "PlayfieldDeviceBox", childrenField: 10, indexKey: 15, excludeKey: 42,
        cellInstrumentField: 0, cellMidiField: 0, cellAudioField: 0},
    {boxType: "CompositeDeviceBox", childrenField: 10, indexKey: 5, excludeKey: 0,
        cellInstrumentField: 11, cellMidiField: 12, cellAudioField: 13}
]

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

const parseDylink = (module: WebAssembly.Module): {memorySize: number, tableSize: number} => {
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

export type FullEngine = {
    engine: any
    memory: WebAssembly.Memory
    deviceBuilds(): number
}

export const loadFullEngine = async (sampleRate = 48000): Promise<FullEngine> => {
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engineModule = await WebAssembly.compile(readFileSync(path.join(PUBLIC, "engine.wasm")))
    const engine = new WebAssembly.Instance(engineModule, {env: {memory, __indirect_function_table: table}})
        .exports as any
    engine.init(sampleRate)

    const installOptional = (fn: unknown): number => {
        if (fn === undefined) {return 0}
        const index = table.grow(1)
        table.set(index, fn as () => void)
        return index
    }
    for (const {file, boxType} of DEVICES) {
        const module = await WebAssembly.compile(readFileSync(path.join(PUBLIC, file)))
        const {memorySize, tableSize} = parseDylink(module)
        const memoryBase = engine.device_alloc(memorySize)
        const tableBase = tableSize > 0 ? table.grow(tableSize) : table.length
        const stackBase = engine.device_alloc(DEVICE_STACK_SIZE)
        const device = new WebAssembly.Instance(module, {
            env: {
                memory, __indirect_function_table: table,
                __memory_base: new WebAssembly.Global({value: "i32", mutable: false}, memoryBase),
                __table_base: new WebAssembly.Global({value: "i32", mutable: false}, tableBase),
                __stack_pointer: new WebAssembly.Global({value: "i32", mutable: true}, stackBase + DEVICE_STACK_SIZE),
                host_pull_events: engine.host_pull_events,
                host_pulse_to_offset: engine.host_pulse_to_offset,
                host_bind_parameter: engine.host_bind_parameter,
                host_update_parameters: engine.host_update_parameters,
                host_first_update_position: engine.host_first_update_position,
                host_next_update_position: engine.host_next_update_position,
                host_resolve_sample: engine.host_resolve_sample,
                host_observe_sample: engine.host_observe_sample,
                host_observe_field: engine.host_observe_field,
                host_bind_sidechain: engine.host_bind_sidechain,
                host_resolve_input: engine.host_resolve_input
            }
        }).exports as any
        device.__wasm_apply_data_relocs?.()
        device.__wasm_call_ctors?.()
        const processIndex = table.grow(1)
        table.set(processIndex, (device.process_events ?? device.process) as () => void)
        const deviceId = engine.device_register(
            processIndex, device.state_size(sampleRate), device.kind(),
            installOptional(device.init), installOptional(device.parameter_changed),
            installOptional(device.field_changed), installOptional(device.sample_changed),
            installOptional(device.reset),
            device.midi_effects_field?.() ?? 0, device.audio_effects_field?.() ?? 0)
        const pointer = engine.input_reserve(boxType.length)
        const bytes = new Uint8Array(memory.buffer, pointer, boxType.length)
        for (let i = 0; i < boxType.length; i++) {bytes[i] = boxType.charCodeAt(i) & 0xff}
        engine.device_set_box_type(deviceId, boxType.length)
    }
    for (const composite of COMPOSITES) {
        const pointer = engine.input_reserve(composite.boxType.length)
        const bytes = new Uint8Array(memory.buffer, pointer, composite.boxType.length)
        for (let i = 0; i < composite.boxType.length; i++) {bytes[i] = composite.boxType.charCodeAt(i) & 0xff}
        engine.composite_register(composite.boxType.length, composite.childrenField, composite.indexKey,
            composite.excludeKey, composite.cellInstrumentField, composite.cellMidiField, composite.cellAudioField)
    }
    return {engine, memory, deviceBuilds: () => engine.device_build_count() >>> 0}
}
