// Parity: an Apparat (scriptable instrument) whose `@param amp` is AUTOMATED by a value track, voicing a note.
// This exercises the Apparat's param-refresh path (it pulls apply_param_changes at the update positions its
// `process` generates) plus the bridge's UNIT->@param mapping, through a non-identity range (0..2) so the mapping
// is observable: a constant curve at unit 0.7 must reach the script as 1.4. Compared to the SAME Processor voiced
// directly with paramChanged(1.4) applied.
import {describe, expect, it} from "vitest"
import {UUID, ValueMapping} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox, WerkstattParameterBox} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const PITCH = 60
const VELOCITY = 0.8
const UNIT = 0.7, MIN = 0, MAX = 2
const MAPPED = ValueMapping.linear(MIN, MAX).y(UNIT) // 1.4 — what the bridge must hand the script

// The script default amp (0) deliberately differs from the automated value, so the test fails unless the engine
// delivers the automated, mapped param. Voiced gain stays well below unity, so the SimpleLimiter is transparent.
const CODE = `// @param amp ${MIN} ${MIN} ${MAX} linear
class Processor {
    voices = []
    amp = ${MIN}
    paramChanged(label, value) { if (label === "amp") this.amp = value }
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, velocity}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.velocity * this.amp * 0.1
                l[i] += s
                r[i] += s
                voice.phase += 440 / sampleRate
            }
        }
    }
}`

describe("apparat automation parity", () => {
    it("delivers an automated, mapped @param to the instrument identically to a direct invocation", async () => {
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
            box.code.setValue("// @apparat js 1 1\n" + CODE)
        })
        const param = WerkstattParameterBox.create(source, UUID.generate(), box => {
            box.owner.refer(apparat.parameters)
            box.label.setValue("amp")
            box.index.setValue(0)
            box.value.setValue(MIN)
            box.defaultValue.setValue(MIN)
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
        // Automate the param: a Value track targeting the param's `value` field, holding a constant unit curve.
        const ampTrack = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.enabled.setValue(true)
            box.index.setValue(1)
            box.target.refer(param.value)
            box.tracks.refer(unit.tracks)
        })
        const ampEvents = ValueEventCollectionBox.create(source, UUID.generate())
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.value.setValue(UNIT)
            box.slope.setValue(NaN)
            box.index.setValue(0)
            box.events.refer(ampEvents.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
        })
        ValueRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.loopDuration.setValue(10_000)
            box.regions.refer(ampTrack.regions)
            box.events.refer(ampEvents.owners)
        })
        source.endTransaction()
        const uuid = UUID.toString(apparat.address.uuid)

        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, CODE))()

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

        // Reference: the SAME Apparat with the MAPPED automation value applied + the note delivered at the start.
        const proc = new (globalThis as any).openDAW.apparatProcessors[uuid].create()
        proc.paramChanged("amp", MAPPED)
        proc.noteOn(PITCH, VELOCITY, 0, 1)
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
