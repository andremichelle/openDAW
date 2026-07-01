// Parity: a Spielwerk (scriptable midi effect) whose `@param shift` is AUTOMATED by a value track, transposing a
// note that a downstream Apparat sine voices. Exercises the Spielwerk param path (observe_script_params for a midi
// effect + apply_param_changes at the range start) and the bridge's `int` mapping. A constant unit-0.5 curve maps
// through linearInteger(0,24) to a fixed semitone shift; compared to the Apparat voiced directly at PITCH+shift.
import {describe, expect, it} from "vitest"
import {UUID, ValueMapping} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SpielwerkDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const PITCH = 60
const VELOCITY = 0.8
const UNIT = 0.5
const SHIFT = ValueMapping.linearInteger(0, 24).y(UNIT) // the semitone shift the bridge maps to (both sides use it)

const APPARAT = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) {
        this.voices.push({id, phase: 0, gain: velocity * 0.2, freq: 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)})
    }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s
                r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

// The script default shift (0) differs from the automated value, so the test fails unless the automation is applied.
const SPIELWERK = `// @param shift 0 0 24 int
class Processor {
    shift = 0
    paramChanged(label, value) { if (label === "shift") this.shift = value }
    * process(block, events) {
        for (const e of events) {
            if (e.gate) { yield {position: e.position, duration: e.duration, pitch: e.pitch + this.shift, velocity: e.velocity, cent: e.cent} }
        }
    }
}`

describe("spielwerk automation parity", () => {
    it("applies an automated @param to the note transform identically to a direct invocation", async () => {
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
            box.code.setValue("// @apparat js 1 1\n" + APPARAT)
        })
        const spielwerk = SpielwerkDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(0)
            box.code.setValue("// @spielwerk js 1 1\n" + SPIELWERK)
        })
        const shift = WerkstattParameterBox.create(source, UUID.generate(), box => {
            box.owner.refer(spielwerk.parameters)
            box.label.setValue("shift")
            box.index.setValue(0)
            box.value.setValue(0)
            box.defaultValue.setValue(0)
        })
        const noteTrack = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const noteEvents = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(noteEvents.events)
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.pitch.setValue(PITCH)
            box.velocity.setValue(VELOCITY)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(noteTrack.regions)
            box.events.refer(noteEvents.owners)
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.loopDuration.setValue(10_000)
        })
        const shiftTrack = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.enabled.setValue(true)
            box.index.setValue(1)
            box.target.refer(shift.value)
            box.tracks.refer(unit.tracks)
        })
        const shiftEvents = ValueEventCollectionBox.create(source, UUID.generate())
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.value.setValue(UNIT)
            box.slope.setValue(NaN)
            box.index.setValue(0)
            box.events.refer(shiftEvents.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
        })
        ValueRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.loopDuration.setValue(10_000)
            box.regions.refer(shiftTrack.regions)
            box.events.refer(shiftEvents.owners)
        })
        source.endTransaction()
        const apparatUuid = UUID.toString(apparat.address.uuid)
        const spielwerkUuid = UUID.toString(spielwerk.address.uuid)

        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, apparatUuid, 1, APPARAT))()
        new Function(ScriptCompiler.wrap(
            {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"}, spielwerkUuid, 1, SPIELWERK))()

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const half = len / 2
        const QUANTA = 16
        engine.stop(); engine.play()
        const wasm = new Float32Array(QUANTA * len)
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            wasm.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
        }
        expect(wasm.some(sample => Math.abs(sample) > 0.01)).toBe(true)
        expect(SHIFT).toBeGreaterThan(0) // the automation actually transposes (else the test would be trivial)

        // Reference: the Apparat voiced directly at the transposed pitch (PITCH + the mapped shift).
        const proc = new (globalThis as any).openDAW.apparatProcessors[apparatUuid].create()
        proc.noteOn(PITCH + SHIFT, VELOCITY, 0, 1)
        const reference = new Float32Array(wasm.length)
        for (let q = 0; q < QUANTA; q++) {
            const base = q * len
            const outL = reference.subarray(base, base + half)
            const outR = reference.subarray(base + half, base + len)
            proc.process([outL, outR], {index: 0, p0: 0, p1: 0, s0: 0, s1: half, bpm: 120, flags: 0})
        }

        expect(maxDiff(wasm, reference)).toBeLessThan(1e-6)
    }, 30000)
})
