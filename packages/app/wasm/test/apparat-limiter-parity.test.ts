// Parity THROUGH the SimpleLimiter: the bridge applies a persistent SimpleLimiter to every Apparat block. The
// other Apparat tests keep the signal below unity so the limiter is transparent; this one drives the voice to a
// 1.5 peak so the limiter actually engages (gain reduction), and the reference applies the SAME limiter (same
// sampleRate, same per-block persistence) via a real AudioBuffer. They must still null-test, proving the bridge
// runs the limiter over the right range with the right persistence — and that it genuinely compresses (output
// peak pulled to ~1.0, not the raw 1.5).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioBuffer, SimpleLimiter} from "@opendaw/lib-dsp"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {maxDiff} from "./helpers/render-harness"

// A loud sine (1.5 peak) so the limiter must compress; phase-accumulated so WASM and the reference stay in lockstep.
const CODE = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * 1.5
                l[i] += s
                r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

describe("apparat limiter parity", () => {
    it("applies the SimpleLimiter identically to a direct invocation", async () => {
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
            box.position.setValue(0)
            box.duration.setValue(10_000)
            box.pitch.setValue(60)
            box.velocity.setValue(1.0)
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
        // The limiter has a 3 ms attack, so the onset transient still passes ~1.5; in STEADY STATE (the second
        // half, well past the attack) it must have pulled the raw 1.5 down to ~unity — proving it engaged.
        const steady = wasm.subarray(wasm.length / 2)
        const steadyPeak = steady.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
        expect(steadyPeak).toBeGreaterThan(0.9) // loud (operating near unity)...
        expect(steadyPeak).toBeLessThan(1.3)    // ...and clearly compressed from the raw 1.5 (soft limiter, ripples)

        // Reference: the SAME Processor, then the SAME persistent SimpleLimiter over each quantum via a real buffer.
        const sampleRate = (globalThis as any).sampleRate as number
        const proc = new (globalThis as any).openDAW.apparatProcessors[uuid].create()
        proc.noteOn(60, 1.0, 0, 1)
        const limiter = new SimpleLimiter(sampleRate)
        const buffer = new AudioBuffer(2)
        const reference = new Float32Array(wasm.length)
        for (let q = 0; q < QUANTA; q++) {
            buffer.clear() // the bridge zero-fills [s0, s1) before process
            proc.process([buffer.getChannel(0), buffer.getChannel(1)], {index: 0, p0: 0, p1: 0, s0: 0, s1: half, bpm: 120, flags: 0})
            limiter.replace(buffer, 0, half)
            const base = q * len
            reference.set(buffer.getChannel(0), base)
            reference.set(buffer.getChannel(1), base + half)
        }

        expect(maxDiff(wasm, reference)).toBeLessThan(1e-6)
    }, 30000)
})
