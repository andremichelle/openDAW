import {describe, expect, it, beforeEach} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, CaptureAudioBox, TrackBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TrackType} from "../timeline/TrackType"
import {TransferRegions} from "./TransferRegions"

const createSkeleton = (): ProjectSkeleton =>
    ProjectSkeleton.empty({createDefaultUser: true, createOutputCompressor: false})

const createTrackWithRegion = (skeleton: ProjectSkeleton, position: number = 100, duration: number = 200): {
    audioUnitBox: AudioUnitBox,
    trackBox: TrackBox,
    regionBox: ValueRegionBox,
    collectionBox: ValueEventCollectionBox
} => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    const captureBox = CaptureAudioBox.create(boxGraph, UUID.generate())
    const audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(AudioUnitType.Instrument)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.capture.refer(captureBox)
        box.index.setValue(1)
    })
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.tracks.refer(audioUnitBox.tracks)
        box.target.refer(audioUnitBox)
        box.index.setValue(0)
    })
    const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    const regionBox = ValueRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(position)
        box.duration.setValue(duration)
        box.loopDuration.setValue(duration)
        box.hue.setValue(42)
        box.events.refer(collectionBox.owners)
        box.regions.refer(trackBox.regions)
    })
    return {audioUnitBox, trackBox, regionBox, collectionBox}
}

describe("TransferRegions.transfer", () => {
    let skeleton: ProjectSkeleton

    beforeEach(() => {skeleton = createSkeleton()})

    describe("same graph", () => {
        it("copies region to same track at new position", () => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox, regionBox} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(regionBox, trackBox, 500, false)
            boxGraph.endTransaction()
            expect(copied.position.getValue()).toBe(500)
            expect(copied.graph).toBe(boxGraph)
            expect(trackBox.regions.pointerHub.incoming().length).toBe(2)
            boxGraph.verifyPointers()
        })

        it("copies region to different track", () => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox: trackA, regionBox, audioUnitBox} = createTrackWithRegion(skeleton)
            const trackB = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Value)
                box.tracks.refer(audioUnitBox.tracks)
                box.target.refer(audioUnitBox)
                box.index.setValue(1)
            })
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(regionBox, trackB, 300, false)
            boxGraph.endTransaction()
            expect(copied.position.getValue()).toBe(300)
            const targetUuid = copied.regions.targetVertex.unwrap().box.address.uuid
            expect(UUID.equals(targetUuid, trackB.address.uuid)).toBe(true)
            expect(trackB.regions.pointerHub.incoming().length).toBe(1)
            expect(trackA.regions.pointerHub.incoming().length).toBe(1)
            boxGraph.verifyPointers()
        })

        it("creates new UUID for copied region", () => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox, regionBox} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(regionBox, trackBox, 500, false)
            boxGraph.endTransaction()
            expect(UUID.equals(copied.address.uuid, regionBox.address.uuid)).toBe(false)
        })

        it("preserves region properties", () => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox, regionBox} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(regionBox, trackBox, 500, false)
            boxGraph.endTransaction()
            expect(copied.duration.getValue()).toBe(200)
            expect(copied.loopDuration.getValue()).toBe(200)
            expect(copied.hue.getValue()).toBe(42)
        })

        it("deletes source when deleteSource is true", () => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox, regionBox} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            TransferRegions.transfer(regionBox, trackBox, 500)
            boxGraph.endTransaction()
            expect(regionBox.isAttached()).toBe(false)
            expect(trackBox.regions.pointerHub.incoming().length).toBe(1)
            boxGraph.verifyPointers()
        })

        it("keeps source when deleteSource is false", () => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox, regionBox} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            TransferRegions.transfer(regionBox, trackBox, 500, false)
            boxGraph.endTransaction()
            expect(regionBox.isAttached()).toBe(true)
            expect(trackBox.regions.pointerHub.incoming().length).toBe(2)
        })

        it("copies event collection dependency with new UUID", () => {
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox, regionBox, collectionBox} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(regionBox, trackBox, 500, false)
            boxGraph.endTransaction()
            const copiedEventsVertex = copied.events.targetVertex.unwrap()
            const copiedCollectionUuid = copiedEventsVertex.box.address.uuid
            expect(UUID.equals(copiedCollectionUuid, collectionBox.address.uuid)).toBe(false)
            boxGraph.verifyPointers()
        })
    })

    describe("cross graph", () => {
        let sourceSkeleton: ProjectSkeleton

        beforeEach(() => {sourceSkeleton = createSkeleton()})

        it("copies region to target graph at given position", () => {
            const sourceGraph = sourceSkeleton.boxGraph
            sourceGraph.beginTransaction()
            const {regionBox: sourceRegion} = createTrackWithRegion(sourceSkeleton)
            sourceGraph.endTransaction()
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox: targetTrack} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            const regionsBefore = targetTrack.regions.pointerHub.incoming().length
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(sourceRegion, targetTrack, 500, false)
            boxGraph.endTransaction()
            expect(copied.position.getValue()).toBe(500)
            expect(copied.graph).toBe(boxGraph)
            expect(copied.graph).not.toBe(sourceGraph)
            expect(targetTrack.regions.pointerHub.incoming().length).toBe(regionsBefore + 1)
            boxGraph.verifyPointers()
            sourceGraph.verifyPointers()
        })

        it("creates new UUID for copied region", () => {
            const sourceGraph = sourceSkeleton.boxGraph
            sourceGraph.beginTransaction()
            const {regionBox: sourceRegion} = createTrackWithRegion(sourceSkeleton)
            sourceGraph.endTransaction()
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox: targetTrack} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(sourceRegion, targetTrack, 500, false)
            boxGraph.endTransaction()
            expect(UUID.equals(copied.address.uuid, sourceRegion.address.uuid)).toBe(false)
        })

        it("preserves region properties", () => {
            const sourceGraph = sourceSkeleton.boxGraph
            sourceGraph.beginTransaction()
            const {regionBox: sourceRegion} = createTrackWithRegion(sourceSkeleton, 100, 300)
            sourceGraph.endTransaction()
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox: targetTrack} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            const copied = TransferRegions.transfer(sourceRegion, targetTrack, 500, false)
            boxGraph.endTransaction()
            expect(copied.duration.getValue()).toBe(300)
            expect(copied.loopDuration.getValue()).toBe(300)
            expect(copied.hue.getValue()).toBe(42)
        })

        it("keeps source in source graph when deleteSource is false", () => {
            const sourceGraph = sourceSkeleton.boxGraph
            sourceGraph.beginTransaction()
            const {regionBox: sourceRegion} = createTrackWithRegion(sourceSkeleton)
            sourceGraph.endTransaction()
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox: targetTrack} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            boxGraph.beginTransaction()
            TransferRegions.transfer(sourceRegion, targetTrack, 500, false)
            boxGraph.endTransaction()
            expect(sourceRegion.isAttached()).toBe(true)
            sourceGraph.verifyPointers()
        })

        it("deletes source when deleteSource is true", () => {
            const sourceGraph = sourceSkeleton.boxGraph
            sourceGraph.beginTransaction()
            const {regionBox: sourceRegion} = createTrackWithRegion(sourceSkeleton)
            sourceGraph.endTransaction()
            const {boxGraph} = skeleton
            boxGraph.beginTransaction()
            const {trackBox: targetTrack} = createTrackWithRegion(skeleton)
            boxGraph.endTransaction()
            sourceGraph.beginTransaction()
            boxGraph.beginTransaction()
            TransferRegions.transfer(sourceRegion, targetTrack, 500)
            boxGraph.endTransaction()
            sourceGraph.endTransaction()
            expect(sourceRegion.isAttached()).toBe(false)
            boxGraph.verifyPointers()
            sourceGraph.verifyPointers()
        })
    })
})
