// Isolates the "automation on Revamp doesn't work" report: a Revamp with its low-pass band enabled and its
// frequency AUTOMATED by a value curve (a sweep from a low cutoff to a high one). A 440 Hz Apparat sine is cut
// when the cutoff is below it and passes when above, so the output must grow LOUDER over the sweep. If automation
// on the Revamp param does not reach the device, the output would not change over time.
import {describe, expect, it} from "vitest"
import {UUID, ValueMapping} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, RevampDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

// A 440 Hz sine (pitch 69).
const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: 0.4, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

describe("revamp automation", () => {
    it("sweeps an automated low-pass frequency (the output opens up over the sweep)", async () => {
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
            box.code.setValue("// @apparat js 1 1\n" + SYNTH)
        })
        const revamp = RevampDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.lowPass.enabled.setValue(true)
            box.lowPass.order.setValue(1)
            box.lowPass.q.setValue(0.707)
            box.lowPass.frequency.setValue(200.0) // starting cutoff (overwritten by automation)
        })
        // Note track.
        const noteTrack = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const notes = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(notes.events)
            box.position.setValue(0)
            box.duration.setValue(100_000)
            box.pitch.setValue(69) // 440 Hz
            box.velocity.setValue(1.0)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(noteTrack.regions)
            box.events.refer(notes.owners)
            box.position.setValue(0)
            box.duration.setValue(100_000)
            box.loopDuration.setValue(100_000)
        })
        // Automate revamp.lowPass.frequency: a Value track targeting that field, sweeping unit 0.25 -> 0.75.
        const lowUnit = 0.25, highUnit = 0.75
        const freqTrack = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.enabled.setValue(true)
            box.index.setValue(1)
            box.target.refer(revamp.lowPass.frequency)
            box.tracks.refer(unit.tracks)
        })
        // PPQN = 960; at 120 BPM the 200-quantum render spans ~1024 pulses, so keep the sweep well inside that.
        const SWEEP = 960 // pulses (~0.5 s): the cutoff opens fully within the render window
        const freqEvents = ValueEventCollectionBox.create(source, UUID.generate())
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.value.setValue(lowUnit)
            box.index.setValue(0)
            box.slope.setValue(NaN)
            box.events.refer(freqEvents.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.Linear) // ramp to the next event
        })
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(SWEEP)
            box.value.setValue(highUnit)
            box.index.setValue(1)
            box.slope.setValue(NaN)
            box.events.refer(freqEvents.events)
            InterpolationFieldAdapter.write(box.interpolation, Interpolation.None)
        })
        ValueRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(SWEEP)
            box.loopDuration.setValue(SWEEP)
            box.regions.refer(freqTrack.regions)
            box.events.refer(freqEvents.owners)
        })
        source.endTransaction()
        const uuid = UUID.toString(apparat.address.uuid)
        new Function(ScriptCompiler.wrap(
            {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, SYNTH))()

        // Sanity: the sweep spans a cutoff below and above 440 Hz, so the filter really opens.
        expect(ValueMapping.exponential(20, 20000).y(lowUnit)).toBeLessThan(440)
        expect(ValueMapping.exponential(20, 20000).y(highUnit)).toBeGreaterThan(440)

        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)

        const len = engine.output_len() >>> 0
        const QUANTA = 200 // ~0.5 s at 48k: covers the sweep
        engine.stop(); engine.play()
        const rms: number[] = []
        for (let q = 0; q < QUANTA; q++) {
            engine.render()
            const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
            let sum = 0
            for (let i = 0; i < len; i++) {sum += out[i] * out[i]}
            rms.push(Math.sqrt(sum / len))
        }
        expect(rms.every(value => Number.isFinite(value))).toBe(true)
        const early = rms.slice(10, 40).reduce((a, b) => a + b, 0) / 30
        const late = rms.slice(160, 190).reduce((a, b) => a + b, 0) / 30
        expect(early).toBeGreaterThan(0.0)      // it sounds
        expect(late).toBeGreaterThan(early * 1.5) // the automated cutoff opened, so the 440 Hz tone passes louder
    }, 30000)
})
