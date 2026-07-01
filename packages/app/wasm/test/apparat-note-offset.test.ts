// The Apparat's `process` dispatch splits each render block at note offsets (mirroring render_instrument), so a
// note that begins partway through a quantum sounds only from its sample offset — not from the quantum's start.
// A DC voice (0.3 while held) makes the onset unambiguous. A note at pulse 2 lands at a non-zero, non-block-
// aligned sample offset within the FIRST quantum, so the continuous output is silent up to that offset then steps
// to 0.3. The OLD "deliver all notes, then process the whole block" path would instead sound from sample 0 of the
// note's quantum (a block-aligned onset); asserting the first non-zero sample is mid-quantum guards the split.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const NOTE_POSITION = 2 // pulses: at 120 bpm / 960 PPQN this is sample offset ~50 in quantum 0 (mid-block)
const CODE = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) { l[i] += 0.3; r[i] += 0.3 }
        }
    }
}`

describe("apparat mid-block note onset", () => {
    it("sounds a note from its sample offset, not the start of the quantum", async () => {
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
            box.position.setValue(NOTE_POSITION)
            box.duration.setValue(10_000)
            box.pitch.setValue(60)
            box.velocity.setValue(0.8)
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
        const half = len / 2 // == RenderQuantum (left channel samples per quantum)
        const QUANTA = 4
        engine.stop(); engine.play()
        // Concatenate the LEFT channel across quanta into one continuous timeline.
        const left = new Float32Array(QUANTA * half)
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), q * half)
        }
        const firstNonZero = left.findIndex(sample => Math.abs(sample) > 1e-9)
        expect(firstNonZero).toBeGreaterThan(0)        // the note did NOT sound from sample 0 (not delivered up front)
        expect(firstNonZero).toBeLessThan(half)        // it DID start within the first quantum (its offset, ~50)
        expect(Math.abs(left[firstNonZero] - 0.3)).toBeLessThan(1e-6) // and steps straight to the DC voice level
        expect(left[firstNonZero - 1]).toBe(0)         // the sample just before the onset is exactly silent
    }, 30000)
})
