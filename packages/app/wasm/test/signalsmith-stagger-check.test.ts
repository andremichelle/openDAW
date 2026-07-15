import {describe, it, expect} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioRegionBox, AudioSignalsmithBox, AudioUnitBox, TapeDeviceBox, TrackBox, ValueEventCollectionBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BAR = 3840

// Region UUIDs whose byte-sums differ mod 8 (=quanta), so the engine's uuid-derived phase slot is distinct
// per region and the stagger is deterministic (not subject to random-uuid collisions).
const REGION_UUIDS = [
    UUID.parse("00000000-0000-4000-8000-000000000000"),
    UUID.parse("00000000-0000-4000-8000-000000000001"),
    UUID.parse("00000000-0000-4000-8000-000000000002")
]

const build = (source: any, root: any, bus: any, index: number): void => {
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(root.audioUnits); box.output.refer(bus.input); box.index.setValue(index + 1)
    })
    TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0); box.endInSeconds.setValue(1.0); box.fileName.setValue("synthetic")
    })
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    const region = AudioRegionBox.create(source, REGION_UUIDS[index], box => {
        box.position.setValue(0); box.duration.setValue(64 * BAR); box.loopOffset.setValue(0); box.loopDuration.setValue(2 * BAR)
        box.regions.refer(track.regions); box.file.refer(file); box.events.refer(collection.owners)
    })
    const sig = AudioSignalsmithBox.create(source, UUID.generate())
    WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(sig.warpMarkers); box.position.setValue(0); box.seconds.setValue(0)})
    WarpMarkerBox.create(source, UUID.generate(), box => {box.owner.refer(sig.warpMarkers); box.position.setValue(2 * BAR); box.seconds.setValue(1.0)})
    region.playMode.refer(sig)
}

const capture = async (count: number, quanta: number): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    for (let i = 0; i < count; i++) build(source, rootBox, primaryAudioBusBox, i)
    source.endTransaction()
    const {engine, memory, drainSamples} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    drainSamples()
    engine.stop(); engine.play()
    const out = new Float32Array(quanta * 128)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const left = new Float32Array(memory.buffer, engine.output_ptr(), 128)
        out.set(left, q * 128)
    }
    sync.close()
    return out
}

describe("signalsmith stagger check", () => {
    it("3 voices are phase-staggered, not sample-aligned", async () => {
        const quanta = 200
        const one = await capture(1, quanta)
        const three = await capture(3, quanta)
        // if NOT staggered, three == 3*one exactly. measure the residual after removing the aligned component.
        let alignedErr = 0, energy = 0
        for (let i = 0; i < one.length; i++) {
            alignedErr += Math.abs(three[i] - 3 * one[i])
            energy += Math.abs(three[i])
        }
        const rel = alignedErr / Math.max(energy, 1e-9)
        console.log(`aligned-model residual: ${(rel * 100).toFixed(1)}% (0% => NOT staggered; large => staggered)`)
        expect(rel).toBeGreaterThan(0.05)
    }, 60000)
})
