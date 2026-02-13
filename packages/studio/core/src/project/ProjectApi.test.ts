import "./polyfill"
import {afterEach, beforeEach, describe, expect, it} from "vitest"
import {asInstanceOf, Terminable, UUID} from "@opendaw/lib-std"
import {
    AudioUnitBox,
    CaptureAudioBox,
    TrackBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {Project} from "./Project"
import {ProjectEnv} from "./ProjectEnv"

const createEnv = (): ProjectEnv => ({
    audioContext: {} as AudioContext,
    audioWorklets: {} as ProjectEnv["audioWorklets"],
    sampleManager: {
        getOrCreate: () => ({}) as any,
        record: () => {},
        remove: () => {},
        invalidate: () => {},
        register: () => Terminable.Empty
    },
    soundfontManager: {
        getOrCreate: () => ({}) as any,
        remove: () => {},
        invalidate: () => {}
    }
})

describe("ProjectApi.copyRegionTo", () => {
    let project: Project

    beforeEach(() => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputCompressor: false})
        project = Project.fromSkeleton(createEnv(), skeleton, false)
    })

    afterEach(() => project.terminate())

    const createTrackWithRegion = (project: Project): {
        audioUnitBox: AudioUnitBox,
        trackBox: TrackBox,
        regionBox: ValueRegionBox,
        collectionBox: ValueEventCollectionBox
    } => {
        const {boxGraph} = project
        const captureBox = CaptureAudioBox.create(boxGraph, UUID.generate())
        const audioUnitBox = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(project.rootBox.audioUnits)
            box.output.refer(project.masterBusBox.input)
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
            box.position.setValue(100)
            box.duration.setValue(200)
            box.loopDuration.setValue(200)
            box.hue.setValue(0)
            box.events.refer(collectionBox.owners)
            box.regions.refer(trackBox.regions)
        })
        return {audioUnitBox, trackBox, regionBox, collectionBox}
    }

    it("same graph: moves region to target track and updates position", () => {
        const {boxGraph} = project
        boxGraph.beginTransaction()
        const {trackBox: trackA, regionBox} = createTrackWithRegion(project)
        const trackB = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(asInstanceOf(trackA.tracks.targetVertex.unwrap().box, AudioUnitBox).tracks)
            box.target.refer(trackA.tracks.targetVertex.unwrap().box)
            box.index.setValue(1)
        })
        boxGraph.endTransaction()
        boxGraph.beginTransaction()
        project.api.copyRegionTo(regionBox, trackB, 500)
        boxGraph.endTransaction()
        boxGraph.verifyPointers()
        expect(regionBox.position.getValue()).toBe(500)
        const targetUuid = regionBox.regions.targetVertex.unwrap().box.address.uuid
        expect(UUID.equals(targetUuid, trackB.address.uuid)).toBe(true)
        expect(trackB.regions.pointerHub.incoming().length).toBe(1)
        expect(trackA.regions.pointerHub.incoming().length).toBe(0)
    })

    it("different graph: copies region to target track at given position", () => {
        const sourceSkeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputCompressor: false})
        const sourceProject = Project.fromSkeleton(createEnv(), sourceSkeleton, false)
        const sourceGraph = sourceProject.boxGraph
        sourceGraph.beginTransaction()
        const {regionBox: sourceRegion} = createTrackWithRegion(sourceProject)
        sourceGraph.endTransaction()
        const {boxGraph} = project
        boxGraph.beginTransaction()
        const {trackBox: targetTrack} = createTrackWithRegion(project)
        boxGraph.endTransaction()
        const regionsBefore = targetTrack.regions.pointerHub.incoming().length
        boxGraph.beginTransaction()
        project.api.copyRegionTo(sourceRegion, targetTrack, 500)
        boxGraph.endTransaction()
        const regionsAfter = targetTrack.regions.pointerHub.incoming()
        expect(regionsAfter.length).toBe(regionsBefore + 1)
        const copiedRegion = regionsAfter.find(vertex => {
            const box = vertex.box as ValueRegionBox
            return box.position.getValue() === 500
        })
        expect(copiedRegion).toBeDefined()
        const copiedBox = copiedRegion!.box as ValueRegionBox
        expect(copiedBox.duration.getValue()).toBe(200)
        expect(copiedBox.loopDuration.getValue()).toBe(200)
        expect(UUID.equals(copiedBox.address.uuid, sourceRegion.address.uuid)).toBe(false)
        boxGraph.verifyPointers()
        sourceGraph.verifyPointers()
        sourceProject.terminate()
    })
})
