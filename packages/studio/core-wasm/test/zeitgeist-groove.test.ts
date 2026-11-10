// Zeitgeist groove parity at the wasm-binary level. The groove lives in the engine's groove registry: the
// device observes its `groove` pointer ([10]) once and warps through the `host_groove_warp` /
// `host_groove_unwarp` imports. Verified here: the observation, the pull-range and warp contract of
// `process_events` against stub imports, and END-TO-END in the running full engine: a note's rendered onset
// follows the TS groove adapters for a shuffle (live amount edit), a power groove, a stack and no groove.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {clamp, isDefined, moebiusEase, squashUnit, UUID} from "@opendaw/lib-std"
import {Groove, GrooveChain, GrooveCurves, GroovePattern, ppqn} from "@opendaw/lib-dsp"
import {
    ApparatDeviceBox, AudioUnitBox, GrooveFunctionBox, GrooveShuffleBox, GrooveStackBox, GrooveStackEntryBox,
    NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {DEVICE_STACK_SIZE, DeviceExports, parseDylink} from "../src/device-linker"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const PLUGINS = path.resolve(__dirname, "../dist/wasm/plugins")
const SAMPLE_RATE = 48000
const PAGE = 65536
const RECORD_SIZE = 40 // abi::EventRecord (position f64, offset/kind/id/pitch u32, velocity/cent f32, duration f64)
const DEVICE_KIND_MIDI_EFFECT = 2
const INPUT_POSITIONS = [0.0, 240.0, 480.0, 720.0]

const alignUp = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment

type ZeitgeistExports = DeviceExports & {
    process_events: (from: number, to: number, flags: number, statePtr: number, outPtr: number, max: number) => number
}

type ZeitgeistDevice = {
    exports: ZeitgeistExports
    memory: WebAssembly.Memory
    statePtr: number
    outPtr: number
    observations: ReadonlyArray<string>
    pulledRanges: Array<[number, number]>
    slots: Array<number>
}

// The device against stub imports: slot 7 for its groove, warp/unwarp by the given groove
const loadZeitgeist = (groove: Groove): ZeitgeistDevice => {
    const module = new WebAssembly.Module(readFileSync(path.join(PLUGINS, "device_zeitgeist.wasm")))
    const {memorySize, tableSize} = parseDylink(module)
    const memory = new WebAssembly.Memory({initial: 256})
    const table = new WebAssembly.Table({initial: Math.max(tableSize, 1), element: "anyfunc"})
    const memoryBase = 1024
    const stackBase = alignUp(memoryBase + memorySize, 16)
    const stackTop = stackBase + DEVICE_STACK_SIZE
    const observations: Array<string> = []
    const pulledRanges: Array<[number, number]> = []
    const slots: Array<number> = []
    const env: Record<string, unknown> = {
        memory, __indirect_function_table: table,
        __memory_base: new WebAssembly.Global({value: "i32", mutable: false}, memoryBase),
        __table_base: new WebAssembly.Global({value: "i32", mutable: false}, 0),
        __stack_pointer: new WebAssembly.Global({value: "i32", mutable: true}, stackTop),
        host_observe_groove: (pathPtr: number, pathLen: number): number => {
            observations.push(Array.from(new Uint16Array(memory.buffer, pathPtr, pathLen)).join(","))
            return 7
        },
        host_groove_warp: (slot: number, pulse: number): number => {
            slots.push(slot)
            return groove.warp(pulse)
        },
        host_groove_unwarp: (slot: number, pulse: number): number => {
            slots.push(slot)
            return groove.unwarp(pulse)
        },
        host_loop_area: (): number => 0,
        host_pull_events: (from: number, to: number, _flags: number, outPtr: number, max: number): number => {
            pulledRanges.push([from, to])
            const view = new DataView(memory.buffer)
            const positions = INPUT_POSITIONS.filter(position => position >= from && position < to)
            positions.slice(0, max).forEach((position, index) => {
                const base = outPtr + index * RECORD_SIZE
                view.setFloat64(base, position, true)
                view.setUint32(base + 8, 0, true)
                view.setUint32(base + 12, 0, true)
                view.setUint32(base + 16, index, true)
                view.setUint32(base + 20, 60, true)
                view.setFloat32(base + 24, 0.8, true)
                view.setFloat32(base + 28, 0.0, true)
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
    return {exports, memory, statePtr, outPtr, observations, pulledRanges, slots}
}

// The TS reference grooves: the oracles for the engine. Amounts pass Math.fround like the float32 box field.
const shuffleGroove = (amount: number, duration: ppqn): GroovePattern => {
    const h = squashUnit(Math.fround(amount), 0.01)
    return new GroovePattern({duration: () => duration, fx: x => moebiusEase(x, h), fy: y => moebiusEase(y, 1.0 - h)})
}

const powerGroove = (amount: number, duration: ppqn): GroovePattern =>
    new GroovePattern({duration: () => duration, ...GrooveCurves.blend(GrooveCurves.Power, Math.fround(amount))})

const processRange = (device: ZeitgeistDevice, from: number, to: number): ReadonlyArray<number> => {
    const written = device.exports.process_events(from, to, 0, device.statePtr, device.outPtr, 16)
    const view = new DataView(device.memory.buffer)
    return Array.from({length: written}, (_, index) => view.getFloat64(device.outPtr + index * RECORD_SIZE, true))
}

describe("zeitgeist groove (wasm device vs TS grooves)", () => {
    it("observes its groove pointer once", () => {
        const device = loadZeitgeist(Groove.Identity)
        expect(device.exports.kind()).toBe(DEVICE_KIND_MIDI_EFFECT)
        expect(device.exports.state_size(SAMPLE_RATE)).toBeGreaterThan(0)
        expect(device.observations).toEqual(["10"])
    })

    it("pulls the un-warped range and warps every event through its slot", () => {
        const groove = shuffleGroove(0.6, 480)
        const device = loadZeitgeist(groove)
        const positions = processRange(device, 0.0, 960.0)
        expect(positions).toHaveLength(INPUT_POSITIONS.length)
        positions.forEach((position, index) =>
            expect(position).toBeCloseTo(clamp(groove.warp(INPUT_POSITIONS[index]), 0.0, 960.0), 9))
        const [from, to] = device.pulledRanges[0]
        expect(from).toBeCloseTo(groove.unwarp(0.0), 9)
        expect(to).toBeCloseTo(groove.unwarp(960.0), 9)
        expect(new Set(device.slots)).toEqual(new Set([7]))
    })

    it("follows the groove in the running engine for every kind", async () => {
        // FULL engine, real sync: an Apparat instrument outputs DC 0.3 while a note is held, so the note's
        // rendered ONSET sample is measurable. One note at the off-beat (240 pulses) behind a Zeitgeist.
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
        const globalShuffle = rootBox.groove.targetVertex.unwrap().box as GrooveShuffleBox
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
        const power = GrooveFunctionBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
            box.amount.setValue(0.9)
            box.duration.setValue(960)
        })
        const stack = GrooveStackBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(2)
        })
        GrooveStackEntryBox.create(source, UUID.generate(), box => {
            box.stack.refer(stack.entries)
            box.groove.refer(globalShuffle)
            box.index.setValue(0)
        })
        GrooveStackEntryBox.create(source, UUID.generate(), box => {
            box.stack.refer(stack.entries)
            box.groove.refer(power)
            box.index.setValue(1)
        })
        const zeitgeist = ZeitgeistDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.groove.refer(globalShuffle)
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
        const expectOnset = (expected: ppqn, what: string): number => {
            const onset = renderOnset()
            expect(Math.abs(onset - expected * SAMPLES_PER_PULSE), `${what}: onset ${onset} vs ${expected}`).toBeLessThan(64)
            return onset
        }
        const edit = async (change: () => void) => {
            source.beginTransaction()
            change()
            source.endTransaction()
            await sync.settle()
        }
        const swung = expectOnset(shuffleGroove(0.6, 480).warp(240), "global shuffle")
        await edit(() => globalShuffle.amount.setValue(0.5))
        const straight = expectOnset(240, "global shuffle at 50%")
        expect(swung - straight, "the live edit moved the onset earlier").toBeGreaterThan(600)
        await edit(() => globalShuffle.amount.setValue(0.6))
        await edit(() => zeitgeist.groove.refer(power))
        expectOnset(powerGroove(0.9, 960).warp(240), "power")
        await edit(() => power.amount.setValue(0.7))
        expectOnset(powerGroove(0.7, 960).warp(240), "power edited")
        await edit(() => zeitgeist.groove.refer(stack))
        expectOnset(new GrooveChain([shuffleGroove(0.6, 480), powerGroove(0.7, 960)]).warp(240), "stack")
        await edit(() => zeitgeist.groove.defer())
        expectOnset(240, "no groove")
        sync.close()
    }, 60000)
})
