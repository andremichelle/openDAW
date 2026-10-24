import {describe, expect, it} from "vitest"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {UUID} from "@opendaw/lib-std"
import {affectsGroupOverview} from "./GroupOverviewUpdates"

describe("folded group redraws", () => {
    it("ignores mixer parameter edits but follows folder membership and order", () => {
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = ProjectSkeleton.empty({
            createDefaultUser: false, createOutputMaximizer: false
        })
        boxGraph.beginTransaction()
        const track = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox.volume)
            box.type.setValue(TrackType.Value)
        })
        boxGraph.endTransaction()
        const relevant: boolean[] = []
        const subscription = boxGraph.subscribeToAllUpdates({onUpdate: update => {
            relevant.push(affectsGroupOverview(boxGraph, update))
        }})
        boxGraph.beginTransaction()
        primaryAudioUnitBox.volume.setValue(-12)
        primaryAudioUnitBox.panning.setValue(0.25)
        primaryAudioUnitBox.mute.setValue(true)
        boxGraph.endTransaction()
        expect(relevant).toEqual([false, false, false])
        relevant.length = 0
        boxGraph.beginTransaction()
        primaryAudioUnitBox.index.setValue(5)
        primaryAudioUnitBox.isGroup.setValue(true)
        track.index.setValue(1)
        boxGraph.endTransaction()
        expect(relevant).toEqual([true, true, true])
        subscription.terminate()
    })
})
