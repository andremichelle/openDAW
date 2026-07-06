// Zeitgeist groove parity at the wasm-binary level. The groove parameters live on the CONNECTED
// GrooveShuffleBox (the device box's `groove` pointer at [10]), so the device declares field observations
// THROUGH the pointer ([10, 10] amount / [10, 11] duration) instead of `bind_parameter` bindings — the
// engine resolves the pointer at the path head and delivers the target box's values (catch-up + live
// edits + repoint). Automation needs no mirror: the studio's ZeitgeistDeviceEditor creates both groove
// knobs with `disableAutomation: true`, so no Value track can target the groove fields. Verified here:
// the observation paths, `map_parameter` parity against the GrooveShuffleBoxAdapter value mappings (the
// source of truth), the warp `process_events` applies — the upstream is pulled over the UN-warped range
// and each event's position is warped back, exactly the TS `ZeitgeistDeviceProcessor.processNotes` +
// `GroovePattern` composition, live-updated by `field_changed` deliveries (amount 0.5 is the
// straight/identity setting) — and END-TO-END: a groove-amount edit synced into the RUNNING full engine
// moves a note's rendered onset to the GroovePattern oracle's position.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {clamp, isDefined, moebiusEase, panic, squashUnit, UUID} from "@opendaw/lib-std"
import {GroovePattern, ppqn} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {
    ApparatDeviceBox, AudioUnitBox, GrooveShuffleBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox,
    TrackBox, ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {
    AutomatableParameterFieldAdapter, BoxAdapters, BoxAdaptersContext, GrooveShuffleBoxAdapter,
    ParameterFieldAdapters, ProjectSkeleton, ScriptCompiler, TrackType
} from "@opendaw/studio-adapters"
import {DEVICE_STACK_SIZE, DeviceExports, parseDylink} from "../../../studio/core-wasm/src/device-linker"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const PLUGINS = path.resolve(__dirname, "../public/wasm/plugins")
const SAMPLE_RATE = 48000
const PAGE = 65536
const RECORD_SIZE = 40 // abi::EventRecord (position f64, offset/kind/id/pitch u32, velocity/cent f32, duration f64)
const FIELD_KIND_INT = 0
const FIELD_KIND_FLOAT = 1
const DEVICE_KIND_MIDI_EFFECT = 2
const INPUT_POSITIONS = [0.0, 240.0, 480.0, 720.0]

const alignUp = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment

type ZeitgeistExports = DeviceExports & {
    field_changed: (statePtr: number, id: number, kind: number, bits: number, len: number) => void
    map_parameter: (id: number, unit: number) => number
    process_events: (from: number, to: number, flags: number, statePtr: number, outPtr: number, max: number) => number
}

type ZeitgeistDevice = {
    exports: ZeitgeistExports
    memory: WebAssembly.Memory
    statePtr: number
    outPtr: number
    observations: ReadonlyArray<string>
    pulledRanges: Array<[number, number]>
}

const loadZeitgeist = (): ZeitgeistDevice => {
    const module = new WebAssembly.Module(readFileSync(path.join(PLUGINS, "device_zeitgeist.wasm")))
    const {memorySize, tableSize} = parseDylink(module)
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: Math.max(tableSize, 1), element: "anyfunc"})
    const memoryBase = 1024
    const stackBase = alignUp(memoryBase + memorySize, 16)
    const stackTop = stackBase + DEVICE_STACK_SIZE
    const observations: Array<string> = []
    const pulledRanges: Array<[number, number]> = []
    const env: Record<string, unknown> = {
        memory, __indirect_function_table: table,
        __memory_base: new WebAssembly.Global({value: "i32", mutable: false}, memoryBase),
        __table_base: new WebAssembly.Global({value: "i32", mutable: false}, 0),
        __stack_pointer: new WebAssembly.Global({value: "i32", mutable: true}, stackTop),
        host_observe_field: (pathPtr: number, pathLen: number): number => {
            const keys = Array.from(new Uint16Array(memory.buffer, pathPtr, pathLen))
            observations.push(keys.join(","))
            return observations.length - 1
        },
        // The upstream pull: hand back the fixed note-on stream (positions within the requested range),
        // recording the requested (un-warped) range so the pull-range contract is checkable.
        host_pull_events: (from: number, to: number, _flags: number, outPtr: number, max: number): number => {
            pulledRanges.push([from, to])
            const view = new DataView(memory.buffer)
            const positions = INPUT_POSITIONS.filter(position => position >= from && position < to)
            positions.slice(0, max).forEach((position, index) => {
                const base = outPtr + index * RECORD_SIZE
                view.setFloat64(base, position, true)
                view.setUint32(base + 8, 0, true)      // offset
                view.setUint32(base + 12, 0, true)     // kind = EVENT_NOTE_ON
                view.setUint32(base + 16, index, true) // id
                view.setUint32(base + 20, 60, true)    // pitch
                view.setFloat32(base + 24, 0.8, true)  // velocity
                view.setFloat32(base + 28, 0.0, true)  // cent
                view.setFloat64(base + 32, 240.0, true)
            })
            return positions.length
        }
    }
    for (const record of WebAssembly.Module.imports(module)) {
        if (record.kind === "function" && !isDefined(env[record.name])) {
            env[record.name] = (): number => 0
        }
    }
    const exports = new WebAssembly.Instance(module, {env: env as WebAssembly.ModuleImports})
        .exports as unknown as ZeitgeistExports
    exports.__wasm_apply_data_relocs?.()
    exports.__wasm_call_ctors?.()
    const statePtr = alignUp(stackTop, 16)
    const outPtr = alignUp(statePtr + exports.state_size(SAMPLE_RATE), 16)
    const needed = alignUp(outPtr + 16 * RECORD_SIZE + PAGE, PAGE)
    const havePages = memory.buffer.byteLength / PAGE
    if (needed / PAGE > havePages) {memory.grow(needed / PAGE - havePages)}
    exports.init?.(statePtr, SAMPLE_RATE)
    return {exports, memory, statePtr, outPtr, observations, pulledRanges}
}

const floatBits = (value: number): number => {
    const scratch = new DataView(new ArrayBuffer(4))
    scratch.setFloat32(0, value, true)
    return scratch.getUint32(0, true)
}

// The TS reference groove (GrooveShuffleBoxAdapter's GroovePattern parameterization): the oracle for the
// wasm warp. `amount` passes Math.fround, since the box field (and the wire to the device) is a float32.
const referenceGroove = (amount: number, duration: ppqn): GroovePattern => {
    const h = squashUnit(Math.fround(amount), 0.01)
    return new GroovePattern({duration: () => duration, fx: x => moebiusEase(x, h), fy: y => moebiusEase(y, 1.0 - h)})
}

const readPositions = (device: ZeitgeistDevice, count: number): ReadonlyArray<number> => {
    const view = new DataView(device.memory.buffer)
    return Array.from({length: count}, (_, index) => view.getFloat64(device.outPtr + index * RECORD_SIZE, true))
}

const processRange = (device: ZeitgeistDevice, from: number, to: number): ReadonlyArray<number> => {
    const written = device.exports.process_events(from, to, 0, device.statePtr, device.outPtr, 16)
    return readPositions(device, written)
}

const collectGrooveParameters = (): ReadonlyArray<AutomatableParameterFieldAdapter> => {
    class Recorder extends ParameterFieldAdapters {
        readonly recorded: Array<AutomatableParameterFieldAdapter> = []
        register(adapter: AutomatableParameterFieldAdapter) {
            this.recorded.push(adapter)
            return super.register(adapter)
        }
    }
    const {boxGraph, mandatoryBoxes: {rootBox}} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const recorder = new Recorder()
    const context: BoxAdaptersContext = {
        get boxGraph() {return boxGraph as unknown as BoxGraph},
        get boxAdapters() {return boxAdapters},
        get sampleManager() {return panic("sampleManager unused")},
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
    const grooveBox = rootBox.groove.targetVertex.unwrap("rootBox.groove").box as GrooveShuffleBox
    const adapter = new GrooveShuffleBoxAdapter(context, grooveBox)
    const recorded = recorder.recorded.slice()
    adapter.terminate()
    return recorded
}

describe("zeitgeist groove (wasm device vs TS GrooveShuffle)", () => {
    it("declares the groove observations through the device's groove pointer", () => {
        const device = loadZeitgeist()
        expect(device.exports.kind()).toBe(DEVICE_KIND_MIDI_EFFECT)
        expect(device.exports.state_size(SAMPLE_RATE)).toBeGreaterThan(0)
        expect(device.observations).toEqual(["10,10", "10,11"])
    })

    it("map_parameter mirrors the GrooveShuffleBoxAdapter value mappings", () => {
        const device = loadZeitgeist()
        const parameters = collectGrooveParameters()
        const byPath = new Map(parameters.map(parameter => [Array.from(parameter.address.fieldKeys).join(","), parameter]))
        const amount = byPath.get("10") ?? panic("no amount parameter")
        const duration = byPath.get("11") ?? panic("no duration parameter")
        for (const unit of [0.0, 0.25, 0.5, 0.75, 1.0]) {
            expect(device.exports.map_parameter(0, unit)).toBeCloseTo(amount.valueMapping.y(unit) as number, 6)
            expect(device.exports.map_parameter(1, unit)).toBe(duration.valueMapping.y(unit) as number)
        }
    })

    it("seeds the GrooveShuffleBox schema defaults and pulls the un-warped range", () => {
        const device = loadZeitgeist()
        const groove = referenceGroove(0.6, 480)
        const positions = processRange(device, 0.0, 960.0)
        expect(positions).toHaveLength(INPUT_POSITIONS.length)
        positions.forEach((position, index) =>
            expect(position, `default groove @ ${INPUT_POSITIONS[index]}`)
                .toBeCloseTo(clamp(groove.warp(INPUT_POSITIONS[index]), 0.0, 960.0), 9))
        const [from, to] = device.pulledRanges[0]
        expect(from).toBeCloseTo(groove.unwarp(0.0), 9)
        expect(to).toBeCloseTo(groove.unwarp(960.0), 9)
    })

    it("a delivered amount 0.5 straightens the stream (identity) and re-delivery re-swings it", () => {
        const device = loadZeitgeist()
        device.exports.field_changed(device.statePtr, 0, FIELD_KIND_FLOAT, floatBits(0.5), 0)
        expect(processRange(device, 0.0, 960.0)).toEqual(INPUT_POSITIONS)
        // the amount whose squash equals the previously hardcoded h = 0.65: moebius(0.5, 0.65) * 480 = 312
        const legacyAmount = (0.65 - 0.01) / 0.98
        device.exports.field_changed(device.statePtr, 0, FIELD_KIND_FLOAT, floatBits(legacyAmount), 0)
        const groove = referenceGroove(legacyAmount, 480)
        const positions = processRange(device, 0.0, 960.0)
        positions.forEach((position, index) =>
            expect(position, `legacy swing @ ${INPUT_POSITIONS[index]}`)
                .toBeCloseTo(groove.warp(INPUT_POSITIONS[index]), 9))
        expect(positions[1]).toBeCloseTo(312.0, 4)
        expect(positions[3]).toBeCloseTo(792.0, 4)
    })

    it("a delivered duration re-cells the warp and a non-positive one is ignored", () => {
        const device = loadZeitgeist()
        device.exports.field_changed(device.statePtr, 1, FIELD_KIND_INT, 960, 0)
        const groove = referenceGroove(0.6, 960)
        const positions = processRange(device, 0.0, 960.0)
        positions.forEach((position, index) =>
            expect(position, `960 cell @ ${INPUT_POSITIONS[index]}`)
                .toBeCloseTo(groove.warp(INPUT_POSITIONS[index]), 9))
        device.exports.field_changed(device.statePtr, 1, FIELD_KIND_INT, 0, 0)
        const unchanged = processRange(device, 0.0, 960.0)
        unchanged.forEach((position, index) => expect(position).toBeCloseTo(positions[index], 9))
    })

    it("a live groove-amount edit reaches the running engine across the pointer", async () => {
        // FULL engine, real sync: an Apparat instrument outputs DC 0.3 while a note is held, so the note's
        // rendered ONSET sample is measurable. One note at the off-beat (240 pulses) behind a Zeitgeist:
        // the default groove (amount 0.6, duration 480) swings it to warp(240) ≈ 287 pulses; a LIVE edit of
        // the CONNECTED GrooveShuffleBox's amount to 0.5 (the identity) must move the onset back to 240 —
        // the engine delivers the target box's field edit through the device's `groove` pointer.
        const DC_CODE = `class Processor {
            voices = []
            noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
            noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
            process(output, block) {
                const [l, r] = output
                if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += 0.3; r[i] += 0.3 } }
            }
        }`
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + DC_CODE)
        })
        const grooveBox = GrooveShuffleBox.create(source, UUID.generate(), box => {
            box.label.setValue("Shuffle")
            box.duration.setValue(480)
        })
        ZeitgeistDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.groove.refer(grooveBox)
            box.index.setValue(0)
        })
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(240)
            box.duration.setValue(240)
            box.pitch.setValue(60)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(3840)
            box.loopDuration.setValue(3840)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, DC_CODE))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const half = (engine.output_len() >>> 0) >>> 1
        const SAMPLES_PER_PULSE = SAMPLE_RATE / (120.0 / 60.0 * 960.0) // default 120 bpm, PPQN.Quarter 960 -> 25
        const renderOnset = (): number => {
            engine.stop(); engine.play()
            const quanta = Math.ceil(0.5 * SAMPLE_RATE / half)
            const left = new Float32Array(quanta * half)
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), quantum * half)
            }
            const onset = left.findIndex(value => value > 0.1)
            expect(onset, "the note must be audible").toBeGreaterThan(0)
            return onset
        }
        const swung = renderOnset()
        const swungOracle = referenceGroove(0.6, 480).warp(240) * SAMPLES_PER_PULSE
        expect(Math.abs(swung - swungOracle), `swung onset ${swung} vs oracle ${swungOracle}`).toBeLessThan(64)
        source.beginTransaction()
        grooveBox.amount.setValue(0.5) // the identity groove: the off-beat plays straight
        source.endTransaction()
        await sync.settle()
        const straight = renderOnset()
        expect(Math.abs(straight - 240 * SAMPLES_PER_PULSE), `straight onset ${straight}`).toBeLessThan(64)
        expect(swung - straight, "the live edit moved the onset earlier").toBeGreaterThan(600)
        sync.close()
    }, 60000)
})
