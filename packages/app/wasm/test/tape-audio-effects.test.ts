// Regression: an AUDIO/tape track's audio-effects chain must be applied by the wasm engine, exactly like a leaf
// instrument unit. `reconcile_tape` used to wire only player -> strip, silently dropping every effect on an audio
// track (a compressor's makeup, an EQ boost, a gain) -> the mix rendered quieter than the TS studio engine. Here a
// tape plays a constant sample through a +12 dB StereoTool; the boosted level must match the TS engine.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioData, TimeBase} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioRegionBox, AudioUnitBox, CaptureAudioBox, StereoToolDeviceBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const FRAMES = 48000
const AMPLITUDE = 0.3
const BOOST_DB = 12.0

const build = (withEffect: boolean): {source: BoxGraph, fileUuid: string} => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let fileUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    unit.capture.refer(CaptureAudioBox.create(source, UUID.generate()))
    if (withEffect) {
        StereoToolDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(0)
            box.volume.setValue(BOOST_DB); box.panningMixing.setValue(0) // Linear pan law: center is unity, no -3 dB
        })
    }
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(1.0); box.fileName.setValue("const")
    })
    fileUuid = UUID.toString(file.address.uuid)
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.timeBase.setValue(TimeBase.Seconds); box.duration.setValue(1.0)
        box.loopDuration.setValue(1.0); box.gain.setValue(0.0)
        box.regions.refer(track.regions); box.file.refer(file); box.events.refer(collection.owners)
    })
    source.endTransaction()
    return {source, fileUuid}
}

const sampleData = (): AudioData => {
    const data = AudioData.create(48000, FRAMES, 2)
    for (let channel = 0; channel < 2; channel++) {data.frames[channel].fill(AMPLITUDE)}
    return data
}

const wasmRms = async (source: BoxGraph, quanta: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const requestPtr = engine.input_reserve(16)
        const handle = engine.sample_take_request(requestPtr)
        if (handle < 0) {break}
        const pointer = engine.sample_allocate(handle, FRAMES * 2 * 4)
        for (let channel = 0; channel < 2; channel++) {
            new Float32Array(memory.buffer, pointer + channel * FRAMES * 4, FRAMES).fill(AMPLITUDE)
        }
        engine.sample_set_ready(handle, FRAMES, 2, 48000)
    }
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    let sum = 0, count = 0
    for (let q = 0; q < quanta; q++) {
        engine.render()
        if (q < quanta / 2) {continue}
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += out[i] * out[i]; count++}
    }
    return Math.sqrt(sum / count)
}

const tsRms = async (source: BoxGraph, fileUuid: string, quanta: number): Promise<number> => {
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map<string, AudioData>([[fileUuid, sampleData()]]), quanta)
    let sum = 0, count = 0
    for (let q = Math.floor(quanta / 2); q < quanta; q++) {
        for (let i = 0; i < 256; i++) {const value = ts.buffer[q * 256 + i]; sum += value * value; count++}
    }
    return Math.sqrt(sum / count)
}

describe("tape audio effects", () => {
    it("a +12 dB StereoTool on an audio track is applied (not dropped) and matches TS", async () => {
        const Q = 100
        const withoutFx = build(false)
        const baselineTs = await tsRms(withoutFx.source, withoutFx.fileUuid, Q)
        const baselineWasm = await wasmRms(build(false).source, Q)
        expect(Math.abs(20 * Math.log10(baselineWasm / baselineTs))).toBeLessThan(0.5) // dry tape matches

        const withFx = build(true)
        const boostedTs = await tsRms(withFx.source, withFx.fileUuid, Q)
        const boostedWasm = await wasmRms(build(true).source, Q)
        // TS applies the +12 dB boost; the wasm must too (it used to ignore audio-track effects -> ~-12 dB).
        expect(20 * Math.log10(boostedTs / baselineTs)).toBeGreaterThan(6.0) // TS is clearly boosted
        expect(Math.abs(20 * Math.log10(boostedWasm / boostedTs))).toBeLessThan(0.5) // wasm matches TS
    }, 120000)
})
