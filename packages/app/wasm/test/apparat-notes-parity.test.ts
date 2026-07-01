// Parity: an Apparat (scriptable instrument) sine synth VOICED BY A NOTE. A note region holds one long note at
// pulse 0; the engine delivers it to the user `Processor` via the bridge's `host_script_note_on`. We render
// through the WASM engine and compare to the SAME `Processor` run directly with the note delivered at the start
// (the note is long enough that no note-off falls in the window, so the voice rings the whole time). This proves
// the bridge's note path (pitch / velocity / cent) matches the engine's note cascade.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

const PITCH = 60
const VELOCITY = 0.8
const CODE = `class Processor {
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

describe("apparat notes parity", () => {
    it("voices a note identically to a direct (TS) invocation", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        let apparat!: ApparatDeviceBox
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + CODE)
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
            box.position.setValue(0)
            box.duration.setValue(10_000) // long: no note-off within the captured window
            box.pitch.setValue(PITCH)
            box.velocity.setValue(VELOCITY)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.loopDuration.setValue(10_000)
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
        expect(wasm.some(sample => Math.abs(sample) > 0.01)).toBe(true) // the note sounded

        // Reference: deliver the note at the start, then run the SAME Processor directly per quantum.
        const proc = new (globalThis as any).openDAW.apparatProcessors[uuid].create()
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
