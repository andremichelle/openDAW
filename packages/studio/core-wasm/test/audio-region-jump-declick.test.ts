// Transport jumps between a native region and a Grain / Signalsmith region must not click: the region left behind
// rings out instead of hard-cutting. A 0.5 amplitude 220 Hz sine never steps more than ~0.0144 per sample.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioSignalsmithBox, AudioTimeStretchBox, AudioUnitBox, TapeDeviceBox, TrackBox, TransientMarkerBox, ValueEventCollectionBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const probe = async (mode: "grain" | "signalsmith") => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(8.0); box.fileName.setValue("synthetic")
    })
    for (let index = 0; index < 80; index++) {
        TransientMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(file.transientMarkers); box.position.setValue(index * 0.1)})
    }
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(0); box.duration.setValue(7200); box.loopDuration.setValue(15360)
        box.regions.refer(track.regions); box.file.refer(file); box.events.refer(collection.owners)
    })
    const stretch = mode === "grain"
        ? AudioTimeStretchBox.create(source, UUID.generate(), box => box.transientPlayMode.setValue(TransientPlayMode.Once))
        : AudioSignalsmithBox.create(source, UUID.generate())
    WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(stretch.warpMarkers); box.position.setValue(0); box.seconds.setValue(0.0)})
    WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(stretch.warpMarkers); box.position.setValue(15360); box.seconds.setValue(8.0)})
    const collection2 = ValueEventCollectionBox.create(source, UUID.generate())
    AudioRegionBox.create(source, UUID.generate(), box => {
        box.position.setValue(7680); box.duration.setValue(7300); box.loopDuration.setValue(15360)
        box.regions.refer(track.regions); box.file.refer(file); box.events.refer(collection2.owners)
        box.playMode.refer(stretch)
    })
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    for (; ;) {
        const handle = engine.sample_take_request(engine.input_reserve(16))
        if (handle < 0) {break}
        const frameCount = 48000 * 8
        const pointer = engine.sample_allocate(handle, frameCount * 4)
        const frames = new Float32Array(memory.buffer, pointer, frameCount)
        for (let frame = 0; frame < frameCount; frame++) {frames[frame] = 0.5 * Math.sin((2 * Math.PI * 220 * frame) / 48000)}
        engine.sample_set_ready(handle, frameCount, 1, 48000)
    }
    await sync.settle()
    engine.play()
    const len = engine.output_len() >>> 0
    const left: number[] = []
    const seeks: Array<[number, string]> = []
    for (let round = 0; round < 10; round++) {
        for (const [target, label] of [[2000 + round * 37, "A"], [9000 + round * 41, "B"]] as const) {
            engine.set_position(target)
            seeks.push([left.length, `->${label}`])
            for (let q = 0; q < 60; q++) {
                engine.render()
                const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
                for (let i = 0; i < 128; i++) {left.push(out[i])}
            }
        }
    }
    for (const [at, label] of seeks) {
        let worst = 0
        for (let i = Math.max(1, at - 4); i < at + 1200; i++) {worst = Math.max(worst, Math.abs(left[i] - left[i - 1]))}
        expect(worst, `${mode} jump ${label} at sample ${at}`).toBeLessThan(0.04)
    }
}

describe("audio-region transport jump declick", () => {
    it("jumping between a native and a Grain region does not click", async () => {await probe("grain")}, 120000)
    it("jumping between a native and a Signalsmith region does not click", async () => {await probe("signalsmith")}, 120000)
})
