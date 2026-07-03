// Regression: the AudioUnit VOLUME (and panning) must follow its automation. A unit whose volume is automated
// from 0% (silence) up to full must be SILENT at transport start and LOUD after the ramp — even though its
// static volume field is 0 dB (loud). Before the fix the WASM engine bound the strip only to the static field,
// so an automated fader was ignored and the channel played at 0 dB from the start (the Nite.odb bug). The
// instrument outputs a constant DC (0.3) while a note is held, so the output level IS the fader value.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {Interpolation} from "@opendaw/lib-dsp"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const DC = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push(id) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice !== id) }
    process(output, block) {
        const [l, r] = output
        if (this.voices.length > 0) { for (let i = block.s0; i < block.s1; i++) { l[i] += 0.3; r[i] += 0.3 } }
    }
}`

describe("strip volume automation", () => {
    it("a unit with volume automated from 0 is silent at t=0 and loud after the ramp", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        const SWEEP = 4800 // pulses (~2.5 s at 120 BPM): volume ramps unit 0 -> 1 across the render
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
            box.volume.setValue(0.0) // static volume 0 dB (loud) — proves the automation, not the field, drives it
        })
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.code.setValue("// @apparat js 1 1\n" + DC)
        })
        const notes = TrackBox.create(source, UUID.generate(), box => {
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
            box.duration.setValue(200_000)
            box.pitch.setValue(60)
            box.velocity.setValue(0.8)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(notes.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(200_000)
            box.loopDuration.setValue(200_000)
        })
        // Automate the unit VOLUME (key 12): a Value track sweeping unit 0.0 -> 1.0 over [0, SWEEP).
        const volumeTrack = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.enabled.setValue(true)
            box.index.setValue(1)
            box.target.refer(unit.volume)
            box.tracks.refer(unit.tracks)
        })
        const volumeEvents = ValueEventCollectionBox.create(source, UUID.generate())
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.value.setValue(0.0) // unit 0 -> -96 dB -> silence
            box.index.setValue(0)
            box.slope.setValue(NaN)
            box.events.refer(volumeEvents.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.Linear)
        })
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(SWEEP)
            box.value.setValue(1.0) // unit 1 -> +6 dB -> loud
            box.index.setValue(1)
            box.slope.setValue(NaN)
            box.events.refer(volumeEvents.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
        })
        ValueRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(SWEEP)
            box.loopDuration.setValue(SWEEP)
            box.regions.refer(volumeTrack.regions)
            box.events.refer(volumeEvents.owners)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
            UUID.toString(apparat.address.uuid), 1, DC))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const len = engine.output_len() >>> 0
        const half = len >>> 1
        const QUANTA = Math.ceil(3 * 48000 / half) // ~3 s (past the 2.5 s sweep)
        engine.stop(); engine.play()
        const left = new Float32Array(QUANTA * half)
        for (let quantum = 0; quantum < QUANTA; quantum++) {
            engine.render()
            left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), quantum * half)
        }
        const firstQuantumPeak = left.subarray(0, half).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
        const lastQuantumPeak = left.subarray(left.length - half).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
        console.log(`strip volume: t=0 peak=${firstQuantumPeak.toExponential(2)}  end peak=${lastQuantumPeak.toFixed(3)}`)
        expect(firstQuantumPeak).toBeLessThan(1e-3)  // volume automated to 0 -> silent at the start
        expect(lastQuantumPeak).toBeGreaterThan(0.1) // ramped up -> the DC voice is audible after the sweep
    }, 60000)
})
