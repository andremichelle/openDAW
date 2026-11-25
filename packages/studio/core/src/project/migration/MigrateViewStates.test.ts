import {describe, expect, it} from "vitest"
import {asInstanceOf, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox, TrackBox, UserInterfaceBox, ViewStateBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {migrateViewStates} from "./MigrateViewStates"

const setup = (createDefaultUser: boolean) => {
    const skeleton = ProjectSkeleton.empty({createDefaultUser, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    boxGraph.beginTransaction()
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(AudioUnitType.Bus)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
        box.groupCollapsed.setValue(true)
        box.userInterface.automationCollapsed.setValue(true)
        box.userInterface.height.setValue(77)
    })
    const createTrack = (index: number, height: number): TrackBox => TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.index.setValue(index)
        box.tracks.refer(unit.tracks)
        box.target.refer(unit)
        box.height.setValue(height)
    })
    const resized = createTrack(0, 120)
    const untouched = createTrack(1, 0)
    boxGraph.endTransaction()
    return {skeleton, unit, resized, untouched}
}

const entriesOf = (user: UserInterfaceBox) => user.viewStates.pointerHub.incoming()
    .map(pointer => asInstanceOf(pointer.box, ViewStateBox))
    .map(entry => ({
        target: entry.target.targetVertex.unwrap().box.address.uuid,
        groupCollapsed: entry.groupCollapsed.getValue(),
        automationCollapsed: entry.automationCollapsed.getValue(),
        height: entry.height.getValue()
    }))
    .toSorted((left, right) => left.height - right.height)

describe("migrateViewStates", () => {
    it("moves collapse states and heights into the first user, once", () => {
        const {skeleton: {boxGraph, mandatoryBoxes: {userInterfaceBoxes}}, unit, resized} = setup(true)
        migrateViewStates(boxGraph, userInterfaceBoxes)
        const expected = [
            {target: unit.address.uuid, groupCollapsed: true, automationCollapsed: true, height: 77},
            {target: resized.address.uuid, groupCollapsed: false, automationCollapsed: false, height: 120}
        ]
        expect(entriesOf(userInterfaceBoxes[0])).toEqual(expected)
        migrateViewStates(boxGraph, userInterfaceBoxes)
        expect(entriesOf(userInterfaceBoxes[0])).toEqual(expected)
        const loaded = ProjectSkeleton.decode(ProjectSkeleton.encode(boxGraph))
        const loadedUnit = asInstanceOf(loaded.boxGraph.findBox(unit.address.uuid).unwrap(), AudioUnitBox)
        expect(loadedUnit.groupCollapsed.getValue()).toBe(false)
        expect(loadedUnit.userInterface.height.getValue()).toBe(0)
        migrateViewStates(loaded.boxGraph, loaded.mandatoryBoxes.userInterfaceBoxes)
        expect(entriesOf(loaded.mandatoryBoxes.userInterfaceBoxes[0])).toEqual(expected)
    })
    it("does nothing without a user", () => {
        const {skeleton: {boxGraph}} = setup(false)
        const count = boxGraph.boxes().length
        migrateViewStates(boxGraph, [])
        expect(boxGraph.boxes().length).toBe(count)
    })
})
