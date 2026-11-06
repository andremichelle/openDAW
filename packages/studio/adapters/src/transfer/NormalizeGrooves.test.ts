import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    GrooveShuffleBox,
    GrooveStackBox,
    GrooveStackEntryBox,
    RootBox,
    TrackBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "./TransferUtils"

const listed = (rootBox: RootBox) => rootBox.grooves.pointerHub.incoming()
    .map(pointer => pointer.box as GrooveShuffleBox | GrooveStackBox)
    .sort((a, b) => a.index.getValue() - b.index.getValue())
    .map(box => box.label.getValue())

describe("normalizeGrooves", () => {
    it("puts pasted grooves behind the existing ones and renames only them", () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        const add = (label: string, index: number) => GrooveShuffleBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.collection.refer(rootBox.grooves)
            box.index.setValue(index)
        })
        boxGraph.beginTransaction()
        add("A", 1)
        add("B", 2)
        boxGraph.endTransaction()
        expect(listed(rootBox)).toEqual(["Global Shuffle", "A", "B"])
        boxGraph.beginTransaction()
        const pasted = [add("A", 1), add("C", 0)]
        TransferUtils.normalizeGrooves(boxGraph, TransferUtils.among(pasted))
        boxGraph.endTransaction()
        expect(listed(rootBox)).toEqual(["Global Shuffle", "A", "B", "C", "A 2"])
    })

    it("a used groove from outside the list joins its end with a unique label", () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox}} = skeleton
        boxGraph.beginTransaction()
        GrooveShuffleBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Swing")
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
        })
        const orphan = GrooveShuffleBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Swing")
            box.index.setValue(0)
        })
        // a listed stack keeps the orphan in use, like a Zeitgeist from an old preset
        const stack = GrooveStackBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Stack")
            box.collection.refer(rootBox.grooves)
            box.index.setValue(2)
        })
        GrooveStackEntryBox.create(boxGraph, UUID.generate(), box => {
            box.stack.refer(stack.entries)
            box.groove.refer(orphan)
        })
        TransferUtils.normalizeGrooves(boxGraph, () => false)
        boxGraph.endTransaction()
        expect(listed(rootBox)).toEqual(["Global Shuffle", "Swing", "Stack", "Swing 2"])
    })

    it("pasted No Sync audio drops its groove, a groove only it used goes with it", () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const track = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const file = AudioFileBox.create(boxGraph, UUID.generate())
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        const content = <B extends AudioRegionBox | AudioClipBox>(box: B): void => {
            box.file.refer(file)
            box.events.refer(events.owners)
            if (box instanceof AudioRegionBox) {box.regions.refer(track.regions)} else {box.clips.refer(track.clips)}
        }
        const groove = (label: string) => GrooveShuffleBox.create(boxGraph, UUID.generate(), box => box.label.setValue(label))
        const [lonely, shared] = [groove("Lonely"), groove("Shared")]
        const noSyncRegion = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            content(box)
            box.groove.refer(lonely)
        })
        const noSyncClip = AudioClipBox.create(boxGraph, UUID.generate(), box => {
            content(box)
            box.groove.refer(shared)
        })
        const pitch = AudioPitchStretchBox.create(boxGraph, UUID.generate())
        const marker = WarpMarkerBox.create(boxGraph, UUID.generate(), box => box.owner.refer(pitch.warpMarkers))
        const pitchRegion = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            content(box)
            box.playMode.refer(pitch)
            box.groove.refer(shared)
        })
        TransferUtils.normalizeGrooves(boxGraph, TransferUtils.among([lonely, shared, noSyncRegion, noSyncClip, pitch, marker, pitchRegion]))
        boxGraph.endTransaction()
        expect(noSyncRegion.groove.isEmpty()).toBe(true)
        expect(noSyncClip.groove.isEmpty()).toBe(true)
        expect(lonely.isAttached()).toBe(false)
        expect(pitchRegion.groove.targetVertex.unwrap().box).toBe(shared)
        expect(listed(rootBox)).toEqual(["Global Shuffle", "Shared"])
    })
})
