import {describe, expect, it} from "vitest"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {affectsGroupOverview} from "./GroupOverviewUpdates"

describe("folded group redraws", () => {
    it("ignores mixer parameter edits but follows folder membership and order", () => {
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = ProjectSkeleton.empty({
            createDefaultUser: false, createOutputMaximizer: false
        })
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
        boxGraph.endTransaction()
        expect(relevant).toEqual([true, true])
        subscription.terminate()
    })
})
