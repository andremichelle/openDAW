// Reproduces "an audio region does not loop in the wasm — it stops playing" (seen in Chaotics, whose tape region
// has loopDuration < duration). A region loops the first 0.5 s of a 1 s DC sample over a 4 s span; rendered past
// the 1 s sample length, TS keeps looping (steady DC), but the wasm free-running read head runs off the end of
// the sample and goes silent. Compare the wasm to the TS engine in a window WELL PAST the sample length.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioData, TimeBase} from "@opendaw/lib-dsp"
import {AudioFileBox, AudioRegionBox, AudioUnitBox, CaptureAudioBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {renderTs} from "./helpers/render-ts"

const DC = 0.5
const FRAMES = 48000 // a 1 s sample

const build = (): {source: BoxGraph, fileUuid: string} => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let fileUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    unit.capture.refer(CaptureAudioBox.create(source, UUID.generate()))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(1.0); box.fileName.setValue("dc")
    })
    fileUuid = UUID.toString(file.address.uuid)
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.timeBase.setValue(TimeBase.Seconds); box.duration.setValue(4.0)
        box.loopDuration.setValue(0.5); box.gain.setValue(0.0) // loops the first 0.5 s of the sample, 8x
        box.regions.refer(track.regions); box.file.refer(file); box.events.refer(collection.owners)
    })
    source.endTransaction()
    return {source, fileUuid}
}

const sample = (): AudioData => {
    const data = AudioData.create(48000, FRAMES, 2)
    for (let channel = 0; channel < 2; channel++) {data.frames[channel].fill(DC)}
    return data
}

const wasmRms = async (source: BoxGraph, fromQ: number, toQ: number): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    for (; ;) {
        const rp = engine.input_reserve(16); const h = engine.sample_take_request(rp); if (h < 0) {break}
        const p = engine.sample_allocate(h, FRAMES * 2 * 4)
        for (let c = 0; c < 2; c++) {new Float32Array(memory.buffer, p + c * FRAMES * 4, FRAMES).fill(DC)}
        engine.sample_set_ready(h, FRAMES, 2, 48000)
    }
    await sync.settle(); engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0; engine.stop(); engine.play()
    let sum = 0, n = 0
    for (let q = 0; q < toQ; q++) {
        engine.render()
        if (q < fromQ) {continue}
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        for (let i = 0; i < len; i++) {sum += out[i] * out[i]; n++}
    }
    return Math.sqrt(sum / n)
}

const tsRms = async (source: BoxGraph, fileUuid: string, fromQ: number, toQ: number): Promise<number> => {
    const ts = await renderTs(ProjectSkeleton.encode(source), new Map([[fileUuid, sample()]]), toQ)
    let sum = 0, n = 0
    for (let q = fromQ; q < toQ; q++) {
        for (let i = 0; i < 256; i++) {const v = ts.buffer[q * 256 + i]; sum += v * v; n++}
    }
    return Math.sqrt(sum / n)
}

describe("tape region loop", () => {
    it("a region with loopDuration < duration keeps looping past the sample length (matches TS)", async () => {
        // ~2.1 s .. 2.9 s: well past the 1 s sample, so a non-looping read would be silent here.
        const FROM = 800, TO = 1100
        const built = build()
        const ts = await tsRms(built.source, built.fileUuid, FROM, TO)
        const wasm = await wasmRms(build().source, FROM, TO)
        expect(ts).toBeGreaterThan(0.4) // TS loops -> steady DC 0.5
        expect(Math.abs(20 * Math.log10(wasm / ts))).toBeLessThan(1.0) // the wasm must loop too, not go silent
    }, 60000)
})
