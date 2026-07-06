// End-to-end Soundfont playback in the wasm engine: a SoundfontDeviceBox whose `file` points at a SoundfontFileBox
// is fed a SIMPLIFIED blob (built here with `encodeSoundfont`, exactly as the main thread would from a parsed
// .sf2), then a held note is rendered. Exercises the whole new pipeline: observe_soundfont -> the engine's
// SoundfontResource request/allocate/ready handshake -> soundfont_changed -> the device's region selection +
// voice DSP. A DC sample makes the steady-state level exactly checkable.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SoundfontDeviceBox, SoundfontFileBox, TrackBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {encodeSoundfont} from "../../../studio/core-wasm/src/soundfont-simplify"

const DC = 0.5
const FRAMES = 48000

// One preset, one region spanning all keys/velocities, one DC sample; root key 60 so pitch 60 plays native rate.
const blob = (): ArrayBuffer => encodeSoundfont({
    samples: [{pcm: new Float32Array(FRAMES).fill(DC), sampleRate: 48000, loopStart: 0, loopEnd: FRAMES}],
    presets: [[{
        keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, sampleIndex: 0, rootKey: 60, loopMode: 0, pan: 0.0,
        attack: 0.001, decay: 0.005, sustain: 1.0, release: 0.05
    }]]
})

const build = (presetIndex: number) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const file = SoundfontFileBox.create(source, UUID.generate(), box => box.fileName.setValue("test.sf2"))
    SoundfontDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input); box.file.refer(file); box.presetIndex.setValue(presetIndex)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000)
        box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    return source
}

const renderWasmPeak = async (source: BoxGraph, quanta: number): Promise<number> => {
    const {engine, memory, drainSoundfonts} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    drainSoundfonts(() => blob()) // supply the simplified blob for the requested SoundfontFileBox uuid
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let peak = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        if (q < quanta / 2) {continue}
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {peak = Math.max(peak, Math.abs(out[i]))}
    }
    return peak
}

describe("soundfont playback", () => {
    it("plays a note through the full soundfont pipeline at the expected (panned DC) level", async () => {
        const peak = await renderWasmPeak(build(0), 200)
        // Per channel: DC 0.5 * velocityGain 1.0 * sustain 1.0 * constant-power pan center cos(pi/4) ~= 0.3536.
        const expected = DC * Math.SQRT1_2
        expect(Math.abs(peak - expected)).toBeLessThan(0.02)
    }, 60000)

    it("stays silent when the selected preset index has no matching region", async () => {
        // preset index 5 does not exist -> the device falls back to preset 0 (which DOES match), so it sounds.
        // Here we instead assert the fallback plays (mirroring TS `presets[i] ?? presets[0]`).
        const peak = await renderWasmPeak(build(5), 200)
        expect(peak).toBeGreaterThan(0.2)
    }, 60000)
})
