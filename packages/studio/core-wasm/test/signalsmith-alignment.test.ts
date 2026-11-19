import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    AudioFileBox,
    AudioRegionBox,
    AudioSignalsmithBox,
    AudioUnitBox,
    TapeDeviceBox,
    TrackBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

// Riffle, SDK 0.0.184: every Signalsmith region played late by 0 to 7 x 128 samples, derived from its uuid, so a
// take lined up with the grid still played late and every cut or duplicate got a new delay.

const BAR = 3840
const RATE = 48000
const BEAT_FRAMES = RATE / 2 // 120 bpm
const SOURCE_SECONDS = 4.0 // two bars

// uuids whose byte sums differ modulo 8, which gave each region a different delay
const REGION_UUIDS = [
    UUID.parse("00000000-0000-4000-8000-000000000000"),
    UUID.parse("00000000-0000-4000-8000-000000000003"),
    UUID.parse("00000000-0000-4000-8000-000000000007")
]

type Placement = { position: number, loopOffset: number }

const build = (source: ProjectSkeleton["boxGraph"], skeleton: ProjectSkeleton, uuid: UUID.Bytes,
               index: number, {position, loopOffset}: Placement): void => {
    const {mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index + 1)
    })
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0)
        box.endInSeconds.setValue(SOURCE_SECONDS)
        box.fileName.setValue("clicks")
    })
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    const region = AudioRegionBox.create(source, uuid, box => {
        box.position.setValue(position)
        box.duration.setValue(4 * BAR)
        box.loopOffset.setValue(loopOffset)
        box.loopDuration.setValue(2 * BAR)
        box.regions.refer(track.regions)
        box.file.refer(file)
        box.events.refer(collection.owners)
    })
    const signalsmith = AudioSignalsmithBox.create(source, UUID.generate())
    WarpMarkerBox.create(source, UUID.generate(), box => {
        box.owner.refer(signalsmith.warpMarkers)
        box.position.setValue(0)
        box.seconds.setValue(0)
    })
    WarpMarkerBox.create(source, UUID.generate(), box => {
        box.owner.refer(signalsmith.warpMarkers)
        box.position.setValue(2 * BAR)
        box.seconds.setValue(SOURCE_SECONDS)
    })
    region.playMode.refer(signalsmith)
}

// a short burst on every beat of the two-bar source
const clickFrames = (): Float32Array => {
    const frames = new Float32Array(SOURCE_SECONDS * RATE)
    for (let beat = 0; beat < SOURCE_SECONDS * 2; beat++) {
        for (let offset = 0; offset < 32; offset++) {
            frames[beat * BEAT_FRAMES + offset] = 0.9 * (1.0 - offset / 32) * (offset % 2 === 0 ? 1.0 : -1.0)
        }
    }
    return frames
}

const render = async (regions: ReadonlyArray<{ uuid: UUID.Bytes, placement: Placement }>, quanta: number): Promise<Float32Array> => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const {boxGraph: source} = skeleton
    source.beginTransaction()
    regions.forEach(({uuid, placement}, index) => build(source, skeleton, uuid, index, placement))
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle()
    engine.bind()
    await sync.settle()
    engine.set_metronome_enabled(0)
    const clicks = clickFrames()
    for (; ;) {
        const handle = engine.sample_take_request(engine.input_reserve(16))
        if (handle < 0) {break}
        const pointer = engine.sample_allocate(handle, clicks.length * Float32Array.BYTES_PER_ELEMENT)
        new Float32Array(memory.buffer, pointer, clicks.length).set(clicks)
        engine.sample_set_ready(handle, clicks.length, 1, RATE)
    }
    engine.stop()
    engine.play()
    const out = new Float32Array(quanta * 128)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        out.set(new Float32Array(memory.buffer, engine.output_ptr(), 128), quantum * 128)
    }
    sync.close()
    return out
}

// where the loudest sample sits within half a beat around each expected click
const clickErrors = (out: Float32Array, expected: ReadonlyArray<number>): ReadonlyArray<number> => expected.map(frame => {
    let peak = 0, at = frame
    for (let index = Math.max(0, frame - 1200); index < Math.min(out.length, frame + 1200); index++) {
        if (Math.abs(out[index]) > peak) {
            peak = Math.abs(out[index])
            at = index
        }
    }
    return at - frame
})

const QUANTA = Math.ceil(4 * 2 * RATE / 128) + 8 // four bars at 120 bpm

describe("signalsmith regions play on the grid", () => {
    it("plays every click on its beat, whatever the region's uuid", async () => {
        for (const uuid of REGION_UUIDS) {
            const out = await render([{uuid, placement: {position: 0, loopOffset: 0}}], QUANTA)
            // beats of all four bars, the loop wraps after two
            const expected = Array.from({length: 15}, (_, beat) => (beat + 1) * BEAT_FRAMES)
            const errors = clickErrors(out, expected)
            expect(Math.max(...errors.map(Math.abs)), `uuid ${UUID.toString(uuid)}: ${errors.join(", ")}`).toBeLessThanOrEqual(32)
        }
    }, 120000)

    it("plays a region that starts later and a cut on the grid", async () => {
        const out = await render([{uuid: REGION_UUIDS[2], placement: {position: BAR, loopOffset: BAR / 2}}], QUANTA + 400)
        // the region starts at bar two and plays its source from beat three, so its beats stay on the grid
        const expected = Array.from({length: 12}, (_, beat) => 4 * BEAT_FRAMES + (beat + 1) * BEAT_FRAMES)
        const errors = clickErrors(out, expected)
        expect(Math.max(...errors.map(Math.abs)), errors.join(", ")).toBeLessThanOrEqual(32)
    }, 120000)

    it("renders three regions as exactly three times one", async () => {
        const one = await render([{uuid: REGION_UUIDS[0], placement: {position: 0, loopOffset: 0}}], 400)
        const three = await render(REGION_UUIDS.map(uuid => ({uuid, placement: {position: 0, loopOffset: 0}})), 400)
        let error = 0, energy = 0
        for (let index = 0; index < one.length; index++) {
            error += Math.abs(three[index] - 3 * one[index])
            energy += Math.abs(three[index])
        }
        expect(error / energy).toBeLessThan(1e-5)
    }, 120000)
})
