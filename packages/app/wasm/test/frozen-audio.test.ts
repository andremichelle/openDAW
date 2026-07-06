// FROZEN units (TS `FrozenPlaybackProcessor` + `setFrozenAudio`): a unit with frozen PCM plays that audio
// transport-aligned instead of its chain — its synth stops sounding, the frozen samples come out through the
// LIVE strip (the fader still applies), seeks re-seat the read position, and unfreezing restores the chain.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const QUANTUM = 128
const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [left, right] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const value = Math.sin(voice.phase * Math.PI * 2) * 0.5
                left[i] += value; right[i] += value
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

describe("frozen audio", () => {
    it("replaces the chain with transport-aligned PCM, fader stays live, unfreeze restores", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input); box.code.setValue("// @apparat js 1 1\n" + SYNTH)
        })
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0); box.target.refer(unit); box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000); box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions); box.events.refer(events.owners); box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SYNTH))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        const len = engine.output_len() >>> 0
        const measure = (quanta: number): {peak: number, sample: number} => {
            let peak = 0, sample = 0
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
                for (const value of output) {peak = Math.max(peak, Math.abs(value))}
                sample = output[0]
            }
            return {peak, sample}
        }
        engine.stop(); engine.play()
        expect(measure(16).peak, "the live synth sounds").toBeGreaterThan(0.3)
        // Freeze: constant 0.25 PCM (10 s at 48k) — recognisable, unlike the sine.
        const frameCount = 480_000
        const pcm = engine.frozen_allocate(frameCount, 2)
        new Float32Array(memory.buffer, pcm, frameCount).fill(0.25)
        new Float32Array(memory.buffer, pcm + frameCount * 4, frameCount).fill(0.25)
        const pointer = engine.input_reserve(16)
        new Uint8Array(memory.buffer, pointer, 16).set(unit.address.uuid)
        engine.set_frozen_audio(frameCount, 2, 48_000)
        engine.stop(); engine.play()
        const frozen = measure(16)
        expect(frozen.peak, "the frozen PCM plays (0.25, not the 0.5 synth)").toBeCloseTo(0.25, 1)
        // The LIVE fader still applies (-6 dB halves the frozen signal).
        source.beginTransaction()
        unit.volume.setValue(-6)
        source.endTransaction()
        await sync.settle()
        measure(8) // let the strip ramp settle
        expect(measure(8).peak, "the live fader scales the frozen audio").toBeCloseTo(0.25 * Math.pow(10, -6 / 20), 2)
        // A seek past the PCM end reads silence; a seek back replays (transport-aligned reader).
        engine.set_position(100_000)
        expect(measure(16).peak, "beyond the frozen tail: silence").toBe(0)
        engine.set_position(0)
        expect(measure(16).peak).toBeGreaterThan(0.1)
        // Unfreeze restores the live chain.
        source.beginTransaction()
        unit.volume.setValue(0)
        source.endTransaction()
        await sync.settle()
        const clearPointer = engine.input_reserve(16)
        new Uint8Array(memory.buffer, clearPointer, 16).set(unit.address.uuid)
        engine.clear_frozen_audio()
        engine.stop(); engine.play()
        expect(measure(16).peak, "unfrozen: the synth is back").toBeGreaterThan(0.3)
    }, 60000)
})
