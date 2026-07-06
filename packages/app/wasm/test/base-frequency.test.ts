// The project TUNING REFERENCE (RootBox.baseFrequency, TS EngineContext.baseFrequency) reaches the wasm
// engine: the engine catches up on + subscribes to RootBox.baseFrequency and serves it to a device through
// the `host_base_frequency` env import; the Vaporisateur pulls it per note-on, exactly where TS
// `VaporisateurDeviceProcessor.computeFrequency` reads `context.baseFrequency`. Verified end-to-end: a held
// note rendered through the real engine sounds at A4 = 440 Hz at the default; a LIVE edit of
// RootBox.baseFrequency to 432 (synced into the running engine) shifts the fundamental by 432/440 for the
// NEXT note (a running voice is not retuned, mirroring the TS voicing strategies).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLE_RATE = 48000

// Rising zero crossings over a steady segment -> fundamental in Hz.
const estimateFrequency = (samples: Float32Array, sampleRate: number): number => {
    let crossings = 0
    for (let index = 1; index < samples.length; index++) {
        if (samples[index - 1] < 0.0 && samples[index] >= 0.0) {crossings++}
    }
    return crossings * sampleRate / samples.length
}

describe("base frequency (RootBox.baseFrequency -> wasm engine -> device tuning)", () => {
    it("a live baseFrequency edit retunes the next Vaporisateur note", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        // A clean audible patch: ProjectSkeleton leaves the vapo fields at their raw schema defaults (osc
        // volume -Inf dB = silent; cutoff/resonance/times 0, which the device's exponential mappings send to
        // -Inf/NaN), so set an oscillator + a wide-open, resonance-free filter and a fast envelope. A SINE
        // osc gives clean zero crossings for the pitch estimate.
        const vaporisateur = VaporisateurDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input)
            const oscA = box.oscillators.fields()[0]
            oscA.waveform.setValue(0) // Sine
            oscA.volume.setValue(0) // 0 dB, full
            box.cutoff.setValue(20000) // wide open
            box.resonance.setValue(0.5)
            box.attack.setValue(0.005)
            box.decay.setValue(0.1)
            box.sustain.setValue(1.0)
            box.release.setValue(0.05)
        })
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
            box.target.refer(unit); box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        // A4 (MIDI 69) held for the whole region, so a full quantum sweep is one steady tone.
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000)
            box.pitch.setValue(69); box.velocity.setValue(1.0); box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions); box.events.refer(events.owners)
            box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
        })
        source.endTransaction()
        const {engine, memory} = await loadFullEngine(SAMPLE_RATE)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        expect(vaporisateur).toBeDefined()
        engine.set_metronome_enabled(0)
        const half = (engine.output_len() >>> 0) >>> 1
        const render = (): Float32Array => {
            engine.stop(); engine.play()
            const quanta = Math.ceil(1.0 * SAMPLE_RATE / half)
            const left = new Float32Array(quanta * half)
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), quantum * half)
            }
            return left
        }
        // Default tuning (440): the note sounds at A4. Skip the attack transient.
        // Analyse a long steady window (skip the attack) so the zero-crossing estimate resolves to ~1 Hz.
        const defaultTone = render().subarray(4096)
        const peak = defaultTone.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
        expect(peak, `the note must be audible, peak ${peak}`).toBeGreaterThan(0.01)
        const defaultHz = estimateFrequency(defaultTone, SAMPLE_RATE)
        expect(defaultHz, `A4 at the default tuning, got ${defaultHz}`).toBeGreaterThan(435)
        expect(defaultHz).toBeLessThan(445)
        // Retune to 432 live and render a fresh note (stop/play retriggers, so the new voice reads the edit).
        source.beginTransaction()
        rootBox.baseFrequency.setValue(432)
        source.endTransaction()
        await sync.settle()
        const detunedHz = estimateFrequency(render().subarray(4096), SAMPLE_RATE)
        expect(detunedHz, `A4 at a 432 reference, got ${detunedHz}`).toBeGreaterThan(427)
        expect(detunedHz).toBeLessThan(437)
        expect(detunedHz, "the live edit lowered the pitch").toBeLessThan(defaultHz - 2)
        expect(detunedHz / defaultHz, `pitch shifts by ~432/440, got ${detunedHz} / ${defaultHz}`)
            .toBeCloseTo(432 / 440, 2)
        sync.close()
    }, 60000)
})
