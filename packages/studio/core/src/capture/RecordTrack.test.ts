import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {RecordTrack} from "./RecordTrack"

const audioUnitWithRegions = (labels: ReadonlyArray<string>) => {
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    labels.forEach((label, index) => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(index * PPQN.Bar)
            box.duration.setValue(PPQN.Bar)
            box.loopDuration.setValue(PPQN.Bar)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
            box.label.setValue(label)
        })
    })
    boxGraph.endTransaction()
    return primaryAudioUnitBox
}

describe("RecordTrack.lastTakeNumber", () => {
    it("is 0 on an audio unit without takes", () => {
        expect(RecordTrack.lastTakeNumber(audioUnitWithRegions([]))).toBe(0)
    })

    it("is the highest take on the audio unit and ignores regions not named as takes", () => {
        const audioUnitBox = audioUnitWithRegions(["Take 2", "Vocals", "Take 10", "Take 3 (copy)", "take 4"])
        expect(RecordTrack.lastTakeNumber(audioUnitBox)).toBe(10)
    })

    it("ignores a take number too large to count on from", () => {
        const audioUnitBox = audioUnitWithRegions(["Take 2", "Take 20261021154434123", `Take 1${"0".repeat(400)}`])
        expect(RecordTrack.lastTakeNumber(audioUnitBox)).toBe(2)
    })
})
