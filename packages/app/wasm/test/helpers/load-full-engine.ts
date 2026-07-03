// Loads the REAL engine.wasm AND every device side-module (delay, gate, vaporisateur, playfield slot, …) the
// same way the AudioWorklet does (engine-processor.ts), so a test can drive the actual DSP graph — not the
// bare engine with an empty device table. Reuse this for any test that needs real devices / composites.

import * as path from "node:path"
import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import {UUID} from "@opendaw/lib-std"
import {ScriptBridges, ScriptEngine} from "../../src/script-bridge"
import {NamBridges} from "../../src/nam-bridge"

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
    {file: "device_playfield_slot.wasm", boxType: "PlayfieldSampleBox"},
    {file: "device_werkstatt.wasm", boxType: "WerkstattDeviceBox"}, // scriptable audio effect
    {file: "device_apparat.wasm", boxType: "ApparatDeviceBox"},     // scriptable instrument
    {file: "device_spielwerk.wasm", boxType: "SpielwerkDeviceBox"}, // scriptable midi effect
    {file: "device_waveshaper.wasm", boxType: "WaveshaperDeviceBox"}, // audio effect
    {file: "device_crusher.wasm", boxType: "CrusherDeviceBox"}, // audio effect
    {file: "device_fold.wasm", boxType: "FoldDeviceBox"}, // audio effect
    {file: "device_stereo_tool.wasm", boxType: "StereoToolDeviceBox"}, // audio effect
    {file: "device_velocity.wasm", boxType: "VelocityDeviceBox"}, // midi effect
    {file: "device_maximizer.wasm", boxType: "MaximizerDeviceBox"}, // audio effect
    {file: "device_compressor.wasm", boxType: "CompressorDeviceBox"}, // audio effect (sidechain)
    {file: "device_reverb.wasm", boxType: "ReverbDeviceBox"}, // audio effect
    {file: "device_dattorro_reverb.wasm", boxType: "DattorroReverbDeviceBox"}, // audio effect
    {file: "device_soundfont.wasm", boxType: "SoundfontDeviceBox"}, // instrument (preset sampler)
    {file: "device_vocoder.wasm", boxType: "VocoderDeviceBox"}, // audio effect (channel vocoder + sidechain)
    {file: "device_neural_amp.wasm", boxType: "NeuralAmpDeviceBox"} // audio effect (NAM, via the nam bridge)
]
type CompositeSpec = {boxType: string, childrenField: number, indexKey: number, excludeKey: number,
    cellInstrumentField: number, cellMidiField: number, cellAudioField: number, childEnabledKey: number}
const COMPOSITES: ReadonlyArray<CompositeSpec> = [
    {boxType: "PlayfieldDeviceBox", childrenField: 10, indexKey: 15, excludeKey: 42,
        cellInstrumentField: 0, cellMidiField: 0, cellAudioField: 0, childEnabledKey: 22},
    {boxType: "CompositeDeviceBox", childrenField: 10, indexKey: 5, excludeKey: 0,
        cellInstrumentField: 11, cellMidiField: 12, cellAudioField: 13, childEnabledKey: 0}
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
    namBridges: NamBridges
    deviceBuilds(): number
    // Feed a synthetic sample to every load the engine has queued (on seeing an AudioFileBox), so sample-based
    // devices (a Playfield slot) are AUDIBLE in tests. Returns how many it satisfied. The real loader fetches +
    // decodes a file; here we write a fixed 0.5 s 220 Hz mono tone, which is enough to assert real signal. Call
    // it after building the project (and again after any edit that adds a sample).
    drainSamples(): number
}

export const loadFullEngine = async (sampleRate = 48000,
                                     onScriptMessage: (uuid: string, message: string) => void = () => {}): Promise<FullEngine> => {
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engineModule = await WebAssembly.compile(readFileSync(path.join(PUBLIC, "engine.wasm")))
    const engine = new WebAssembly.Instance(engineModule, {env: {
        memory, __indirect_function_table: table,
        host_perf_now: () => performance.now() * 1000.0 // micros clock for the render profiler
    }}).exports as any
    engine.init(sampleRate)
    // User scripts read the `sampleRate` global (an AudioWorkletGlobalScope built-in); provide it in node so the
    // scriptable devices behave exactly as in the worklet.
    ;(globalThis as any).sampleRate = sampleRate
    // The script bridge runs the scriptable devices' user JavaScript over the shared memory (see script-bridge.ts).
    const scriptBridges = new ScriptBridges(memory, engine as ScriptEngine, sampleRate, onScriptMessage)
    // The nam bridge runs the NeuralAmp devices' nam-wasm inference; in node the binary comes from the package.
    const namBridges = new NamBridges(memory, async () => {
        const namWasmPath = createRequire(path.join(__dirname, "load-full-engine.ts")).resolve("@opendaw/nam-wasm/nam.wasm")
        const bytes = readFileSync(namWasmPath)
        // A node Buffer can sit at an offset inside a pooled ArrayBuffer; hand over exactly the file's bytes.
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }, sampleRate)
    const bridgeImports = {...scriptBridges.imports(), ...namBridges.imports()}

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
                host_resolve_soundfont: engine.host_resolve_soundfont,
                host_observe_soundfont: engine.host_observe_soundfont,
                host_observe_field: engine.host_observe_field,
                host_observe_target_string: engine.host_observe_target_string,
                host_bind_sidechain: engine.host_bind_sidechain,
                host_resolve_input: engine.host_resolve_input,
                host_self_uuid: engine.host_self_uuid,
                ...bridgeImports
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
            installOptional(device.soundfont_changed),
            installOptional(device.reset),
            device.midi_effects_field?.() ?? 0, device.audio_effects_field?.() ?? 0,
            device.observe_param_collection_field?.() ?? 0, device.observe_sample_collection_field?.() ?? 0)
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
            composite.excludeKey, composite.cellInstrumentField, composite.cellMidiField, composite.cellAudioField,
            composite.childEnabledKey)
    }
    const drainSamples = (): number => {
        let satisfied = 0
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const frameCount = Math.floor(sampleRate * 0.5)
            const channelCount = 1
            const byteLength = frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT
            const pointer = engine.sample_allocate(handle, byteLength)
            const frames = new Float32Array(memory.buffer, pointer, frameCount)
            for (let frame = 0; frame < frameCount; frame++) {
                frames[frame] = 0.5 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate)
            }
            engine.sample_set_ready(handle, frameCount, channelCount, sampleRate)
            satisfied++
        }
        return satisfied
    }
    // Satisfy pending soundfont requests: the test supplies the simplified blob bytes for each requested uuid
    // (mirrors the main-thread SoundfontLoader that builds the blob from the parsed .sf2).
    const drainSoundfonts = (build: (uuid: string) => ArrayBuffer): number => {
        let satisfied = 0
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.soundfont_take_request(requestPtr)
            if (handle < 0) {break}
            const uuid = UUID.toString(new Uint8Array(memory.buffer.slice(requestPtr, requestPtr + 16)) as UUID.Bytes)
            const blob = new Uint8Array(build(uuid))
            const pointer = engine.soundfont_allocate(handle, blob.byteLength)
            new Uint8Array(memory.buffer, pointer, blob.byteLength).set(blob)
            engine.soundfont_set_ready(handle)
            satisfied++
        }
        return satisfied
    }
    return {engine, memory, namBridges, deviceBuilds: () => engine.device_build_count() >>> 0, drainSamples, drainSoundfonts}
}
