import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {ProjectValidation} from "./ProjectValidation"

describe("ProjectValidation", () => {
    // A parameter field may have at most one automation (Value) track. A file with two trips the field
    // adapter's "Already assigned" assert during load-time catchup, so the project cannot open. The
    // validator must repair it by dropping the surplus track(s).
    it("removes a duplicate automation track targeting the same parameter field", () => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        const field = primaryAudioUnitBox.volume // an automatable parameter field
        boxGraph.beginTransaction()
        const createValueTrack = (index: number): TrackBox => TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(field)
            box.index.setValue(index)
        })
        createValueTrack(0)
        createValueTrack(1)
        boxGraph.endTransaction()

        const automationTracksOnField = () => boxGraph.boxes()
            .filter((box): box is TrackBox => box instanceof TrackBox)
            .filter(box => box.type.getValue() === TrackType.Value
                && box.target.targetAddress.unwrapOrNull()?.toString() === field.address.toString())

        expect(automationTracksOnField()).toHaveLength(2) // the corrupt state
        ProjectValidation.validate(skeleton)
        expect(automationTracksOnField()).toHaveLength(1) // repaired
    })
})
