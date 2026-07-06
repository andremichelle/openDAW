// Numeric parity of the parameter VALUE MAPPINGS between the Rust wasm devices and the TS BoxAdapters (the
// source of truth per convention). Each device wasm is instantiated standalone with a stub host whose
// `host_bind_parameter` records the u16 field path and returns sequential ids, so `init` yields the ordered
// (id, fieldPath) table. The device's `map_parameter(id, unit)` export then returns the REAL value the device
// would store for a UNIT automation value, which must match the TS adapter's `valueMapping.y(unit)` for the
// parameter at the same field path. Every wasm-bound parameter must have a TS adapter parameter and vice
// versa (documented engine-level exceptions aside).
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {isDefined, Option, panic, Terminable, UUID} from "@opendaw/lib-std"
import {Address, BoxGraph, PrimitiveType} from "@opendaw/lib-box"
import {
    ArpeggioDeviceBox, AudioFileBox, AudioUnitBox, CompressorDeviceBox, CrusherDeviceBox, DattorroReverbDeviceBox,
    DelayDeviceBox, FoldDeviceBox, GateDeviceBox, MaximizerDeviceBox, NanoDeviceBox, NeuralAmpDeviceBox,
    PitchDeviceBox, PlayfieldDeviceBox, PlayfieldSampleBox, RevampDeviceBox, ReverbDeviceBox, StereoToolDeviceBox,
    TidalDeviceBox, VaporisateurDeviceBox, VelocityDeviceBox, VocoderDeviceBox, WaveshaperDeviceBox
} from "@opendaw/studio-boxes"
import {
    ArpeggioDeviceBoxAdapter, AutomatableParameterFieldAdapter, BoxAdapters, BoxAdaptersContext, CompressorDeviceBoxAdapter,
    CrusherDeviceBoxAdapter, DattorroReverbDeviceBoxAdapter, DelayDeviceBoxAdapter, FoldDeviceBoxAdapter,
    GateDeviceBoxAdapter, MaximizerDeviceBoxAdapter, NanoDeviceBoxAdapter, NeuralAmpDeviceBoxAdapter,
    ParameterFieldAdapters, PitchDeviceBoxAdapter, PlayfieldSampleBoxAdapter, ProjectSkeleton,
    RevampDeviceBoxAdapter, ReverbDeviceBoxAdapter, SampleLoader, SampleLoaderManager, StereoToolDeviceBoxAdapter,
    TidalDeviceBoxAdapter, VaporisateurDeviceBoxAdapter, VelocityDeviceBoxAdapter, VocoderDeviceBoxAdapter,
    WaveshaperDeviceBoxAdapter
} from "@opendaw/studio-adapters"
import {DEVICE_STACK_SIZE, DeviceExports, parseDylink} from "../../../studio/core-wasm/src/device-linker"

const PLUGINS = path.resolve(__dirname, "../public/wasm/plugins")
const SAMPLE_RATE = 48000
const GRID = [0.0, 0.25, 0.5, 0.75, 1.0]
const PAGE = 65536

const fieldPath = (address: Address): string => Array.from(address.fieldKeys).join(",")
const alignUp = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment

type WasmParameter = {id: number, path: string}
type WasmDevice = {parameters: ReadonlyArray<WasmParameter>, map: (id: number, unit: number) => number}

const loadWasmDevice = (file: string): WasmDevice => {
    const module = new WebAssembly.Module(readFileSync(path.join(PLUGINS, file)))
    const {memorySize, tableSize} = parseDylink(module)
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: Math.max(tableSize, 1), element: "anyfunc"})
    const memoryBase = 1024
    const stackBase = alignUp(memoryBase + memorySize, 16)
    const stackTop = stackBase + DEVICE_STACK_SIZE
    const parameters: Array<WasmParameter> = []
    const env: Record<string, unknown> = {
        memory, __indirect_function_table: table,
        __memory_base: new WebAssembly.Global({value: "i32", mutable: false}, memoryBase),
        __table_base: new WebAssembly.Global({value: "i32", mutable: false}, 0),
        __stack_pointer: new WebAssembly.Global({value: "i32", mutable: true}, stackTop),
        host_bind_parameter: (pathPtr: number, pathLen: number): number => {
            const keys = Array.from(new Uint16Array(memory.buffer, pathPtr, pathLen))
            const id = parameters.length
            parameters.push({id, path: keys.join(",")})
            return id
        }
    }
    for (const record of WebAssembly.Module.imports(module)) {
        if (record.kind === "function" && !isDefined(env[record.name])) {
            env[record.name] = (): number => 0
        }
    }
    const exports = new WebAssembly.Instance(module, {env: env as WebAssembly.ModuleImports})
        .exports as unknown as DeviceExports & {map_parameter: (id: number, unit: number) => number}
    exports.__wasm_apply_data_relocs?.()
    exports.__wasm_call_ctors?.()
    const statePtr = alignUp(stackTop, 16)
    const needed = alignUp(statePtr + exports.state_size(SAMPLE_RATE) + PAGE, PAGE)
    const havePages = memory.buffer.byteLength / PAGE
    if (needed / PAGE > havePages) {memory.grow(needed / PAGE - havePages)}
    exports.init?.(statePtr, SAMPLE_RATE)
    expect(typeof exports.map_parameter, `${file} misses the map_parameter export`).toBe("function")
    return {parameters, map: (id, unit) => exports.map_parameter(id, unit)}
}

// The boxes under test, hosted in a minimal skeleton: one unit carries every audio/midi effect, instruments
// get their own units (one `input` slot each), the Playfield slot sits in a Playfield with a file reference.
const buildBoxes = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    boxGraph.beginTransaction()
    const createUnit = (index: number): AudioUnitBox => AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index)
    })
    const effectUnit = createUnit(1)
    const compressor = CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(0)})
    const crusher = CrusherDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(1)})
    const dattorro = DattorroReverbDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(2)})
    const delay = DelayDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(3)})
    const fold = FoldDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(4)})
    const gate = GateDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(5)})
    const maximizer = MaximizerDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(6)})
    const neuralAmp = NeuralAmpDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(7)})
    const revamp = RevampDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(8)})
    const reverb = ReverbDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(9)})
    const stereoTool = StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(10)})
    const tidal = TidalDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(11)})
    const vocoder = VocoderDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(12)})
    const waveshaper = WaveshaperDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.audioEffects); box.index.setValue(13)})
    const arpeggio = ArpeggioDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.midiEffects); box.index.setValue(0)})
    const pitch = PitchDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.midiEffects); box.index.setValue(1)})
    const velocity = VelocityDeviceBox.create(boxGraph, UUID.generate(), box => {box.host.refer(effectUnit.midiEffects); box.index.setValue(2)})
    const vaporisateurUnit = createUnit(2)
    const nanoUnit = createUnit(3)
    const playfieldUnit = createUnit(4)
    const vaporisateur = VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(vaporisateurUnit.input))
    const nano = NanoDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(nanoUnit.input))
    const playfield = PlayfieldDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(playfieldUnit.input))
    const file = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0)
        box.endInSeconds.setValue(1.0)
        box.fileName.setValue("synthetic")
    })
    const playfieldSample = PlayfieldSampleBox.create(boxGraph, UUID.generate(), box => {
        box.device.refer(playfield.samples)
        box.file.refer(file)
        box.index.setValue(60)
    })
    boxGraph.endTransaction()
    return {boxGraph, compressor, crusher, dattorro, delay, fold, gate, maximizer, neuralAmp, revamp, reverb,
        stereoTool, tidal, vocoder, waveshaper, arpeggio, pitch, velocity, vaporisateur, nano, playfieldSample}
}

const boxes = buildBoxes()

class RecordingParameterFieldAdapters extends ParameterFieldAdapters {
    readonly recorded: Array<AutomatableParameterFieldAdapter> = []
    register(adapter: AutomatableParameterFieldAdapter) {
        this.recorded.push(adapter)
        return super.register(adapter)
    }
}

const stubSampleLoader = (uuid: UUID.Bytes): SampleLoader => ({
    get data() {return Option.None},
    get peaks() {return Option.None},
    get uuid() {return uuid},
    get state() {return {type: "idle"} as const},
    invalidate: () => {},
    subscribe: () => Terminable.Empty
})

const stubSampleManager = (): SampleLoaderManager => ({
    getOrCreate: (uuid: UUID.Bytes) => stubSampleLoader(uuid),
    record: () => {},
    invalidate: () => {},
    remove: () => {},
    register: () => Terminable.Empty
})

const createContext = (boxGraph: BoxGraph, recorder: RecordingParameterFieldAdapters): BoxAdaptersContext => {
    const context: BoxAdaptersContext = {
        get boxGraph() {return boxGraph},
        get boxAdapters() {return boxAdapters},
        get sampleManager() {return sampleManager},
        get soundfontManager() {return panic("soundfontManager unused")},
        get rootBoxAdapter() {return panic("rootBoxAdapter unused")},
        get timelineBoxAdapter() {return panic("timelineBoxAdapter unused")},
        get liveStreamReceiver() {return panic("liveStreamReceiver unused")},
        get liveStreamBroadcaster() {return panic("liveStreamBroadcaster unused")},
        get clipSequencing() {return panic("clipSequencing unused")},
        get parameterFieldAdapters() {return recorder},
        get tempoMap() {return panic("tempoMap unused")},
        get isMainThread() {return false},
        get isAudioContext() {return true},
        terminate: () => {}
    }
    const boxAdapters = new BoxAdapters(context)
    const sampleManager = stubSampleManager()
    return context
}

type TsParameter = {path: string, adapter: AutomatableParameterFieldAdapter}

const collectTsParameters = (create: (context: BoxAdaptersContext) => {terminate(): void}): ReadonlyArray<TsParameter> => {
    const recorder = new RecordingParameterFieldAdapters()
    const adapter = create(createContext(boxes.boxGraph, recorder))
    const parameters = recorder.recorded.map(parameter => ({path: fieldPath(parameter.address), adapter: parameter}))
    adapter.terminate()
    return parameters
}

type DeviceCase = {
    name: string
    file: string
    createAdapter: (context: BoxAdaptersContext) => {terminate(): void}
    // TS adapter parameters the wasm device intentionally does NOT bind (engine-level handling elsewhere).
    tsOnly: ReadonlyArray<string>
}

const CASES: ReadonlyArray<DeviceCase> = [
    {name: "arpeggio", file: "device_arpeggio.wasm",
        createAdapter: context => new ArpeggioDeviceBoxAdapter(context, boxes.arpeggio), tsOnly: []},
    {name: "compressor", file: "device_compressor.wasm",
        createAdapter: context => new CompressorDeviceBoxAdapter(context, boxes.compressor), tsOnly: []},
    {name: "crusher", file: "device_crusher.wasm",
        createAdapter: context => new CrusherDeviceBoxAdapter(context, boxes.crusher), tsOnly: []},
    {name: "dattorro-reverb", file: "device_dattorro_reverb.wasm",
        createAdapter: context => new DattorroReverbDeviceBoxAdapter(context, boxes.dattorro), tsOnly: []},
    {name: "delay", file: "device_delay.wasm",
        createAdapter: context => new DelayDeviceBoxAdapter(context, boxes.delay), tsOnly: []},
    {name: "fold", file: "device_fold.wasm",
        createAdapter: context => new FoldDeviceBoxAdapter(context, boxes.fold), tsOnly: []},
    {name: "gate", file: "device_gate.wasm",
        createAdapter: context => new GateDeviceBoxAdapter(context, boxes.gate), tsOnly: []},
    {name: "maximizer", file: "device_maximizer.wasm",
        createAdapter: context => new MaximizerDeviceBoxAdapter(context, boxes.maximizer), tsOnly: []},
    {name: "nano", file: "device_nano.wasm",
        createAdapter: context => new NanoDeviceBoxAdapter(context, boxes.nano), tsOnly: []},
    {name: "neural-amp", file: "device_neural_amp.wasm",
        createAdapter: context => new NeuralAmpDeviceBoxAdapter(context, boxes.neuralAmp), tsOnly: []},
    {name: "pitch", file: "device_pitch.wasm",
        createAdapter: context => new PitchDeviceBoxAdapter(context, boxes.pitch), tsOnly: []},
    {name: "playfield-sample", file: "device_playfield_sample.wasm",
        createAdapter: context => new PlayfieldSampleBoxAdapter(context, boxes.playfieldSample),
        // mute / solo / exclude are composite-child routing flags the engine reads via the Playfield
        // composite registration (childMuteKey / childSoloKey / excludeKey), not device parameters.
        tsOnly: [fieldPath(boxes.playfieldSample.mute.address), fieldPath(boxes.playfieldSample.solo.address),
            fieldPath(boxes.playfieldSample.exclude.address)]},
    {name: "revamp", file: "device_revamp.wasm",
        createAdapter: context => new RevampDeviceBoxAdapter(context, boxes.revamp), tsOnly: []},
    {name: "reverb", file: "device_reverb.wasm",
        createAdapter: context => new ReverbDeviceBoxAdapter(context, boxes.reverb), tsOnly: []},
    {name: "stereo-tool", file: "device_stereo_tool.wasm",
        createAdapter: context => new StereoToolDeviceBoxAdapter(context, boxes.stereoTool), tsOnly: []},
    {name: "tidal", file: "device_tidal.wasm",
        createAdapter: context => new TidalDeviceBoxAdapter(context, boxes.tidal), tsOnly: []},
    {name: "vaporisateur", file: "device_vaporisateur.wasm",
        createAdapter: context => new VaporisateurDeviceBoxAdapter(context, boxes.vaporisateur),
        // the schema's noise generator is unused by BOTH DSPs (see device-vaporisateur lib.rs header); the
        // TS adapter still wraps its parameters, the wasm device binds none.
        tsOnly: [fieldPath(boxes.vaporisateur.noise.volume.address), fieldPath(boxes.vaporisateur.noise.attack.address),
            fieldPath(boxes.vaporisateur.noise.hold.address), fieldPath(boxes.vaporisateur.noise.release.address)]},
    {name: "velocity", file: "device_velocity.wasm",
        createAdapter: context => new VelocityDeviceBoxAdapter(context, boxes.velocity), tsOnly: []},
    {name: "vocoder", file: "device_vocoder.wasm",
        createAdapter: context => new VocoderDeviceBoxAdapter(context, boxes.vocoder), tsOnly: []},
    {name: "waveshaper", file: "device_waveshaper.wasm",
        createAdapter: context => new WaveshaperDeviceBoxAdapter(context, boxes.waveshaper), tsOnly: []}
]

const expectValue = (rust: number, tsValue: unknown, type: PrimitiveType, label: string): void => {
    if (typeof tsValue === "boolean") {
        expect(rust, label).toBe(tsValue ? 1.0 : 0.0)
        return
    }
    expect(typeof tsValue, label).toBe("number")
    const expected = tsValue as number
    if (type === PrimitiveType.Int32) {
        expect(rust, label).toBe(expected)
        return
    }
    if (!Number.isFinite(expected)) {
        expect(rust, label).toBe(expected)
        return
    }
    const tolerance = Math.max(1e-5, Math.abs(expected) * 1e-4)
    expect(Math.abs(rust - expected), `${label} rust=${rust} ts=${expected}`).toBeLessThanOrEqual(tolerance)
}

describe("param mapping parity (wasm device vs TS BoxAdapter)", () => {
    for (const {name, file, createAdapter, tsOnly} of CASES) {
        it(name, () => {
            const wasm = loadWasmDevice(file)
            const tsParameters = collectTsParameters(createAdapter)
            const tsByPath = new Map(tsParameters.map(parameter => [parameter.path, parameter]))
            const rustPaths = new Set(wasm.parameters.map(parameter => parameter.path))
            const missingInTs = wasm.parameters.filter(parameter => !tsByPath.has(parameter.path))
                .map(parameter => parameter.path)
            const missingInRust = tsParameters
                .filter(parameter => !rustPaths.has(parameter.path) && !tsOnly.includes(parameter.path))
                .map(parameter => parameter.path)
            expect(missingInTs, `${name}: wasm-bound field paths without a TS adapter parameter`).toEqual([])
            expect(missingInRust, `${name}: TS adapter parameters the wasm device never binds`).toEqual([])
            expect(wasm.parameters.length, `${name}: binds at least one parameter`).toBeGreaterThan(0)
            for (const {id, path: keyPath} of wasm.parameters) {
                const ts = tsByPath.get(keyPath)
                if (!isDefined(ts)) {continue}
                for (const unit of GRID) {
                    expectValue(wasm.map(id, unit), ts.adapter.valueMapping.y(unit), ts.adapter.type,
                        `${name} [${keyPath}] '${ts.adapter.name}' @ ${unit}`)
                }
            }
        })
    }
})
