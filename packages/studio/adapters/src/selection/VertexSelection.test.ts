import {beforeEach, describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {BoxEditing, BoxGraph} from "@opendaw/lib-box"
import {AudioBusBox, AudioUnitBox, RootBox, SelectionBox, UserInterfaceBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {VertexSelection} from "./VertexSelection"

describe("VertexSelection", () => {
    let boxGraph: BoxGraph
    let rootBox: RootBox
    let primaryAudioBusBox: AudioBusBox
    let userA: UserInterfaceBox
    let nextIndex: number

    beforeEach(() => {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        boxGraph = skeleton.boxGraph
        rootBox = skeleton.mandatoryBoxes.rootBox
        primaryAudioBusBox = skeleton.mandatoryBoxes.primaryAudioBusBox
        userA = skeleton.mandatoryBoxes.userInterfaceBoxes[0]
        nextIndex = 1
    })

    const createSelectable = (): AudioUnitBox => {
        boxGraph.beginTransaction()
        const box = AudioUnitBox.create(boxGraph, UUID.generate(), unit => {
            unit.type.setValue(AudioUnitType.Instrument)
            unit.collection.refer(rootBox.audioUnits)
            unit.output.refer(primaryAudioBusBox.input)
            unit.index.setValue(nextIndex++)
        })
        boxGraph.endTransaction()
        return box
    }
    const selectDirect = (selectable: AudioUnitBox): SelectionBox => {
        boxGraph.beginTransaction()
        const box = SelectionBox.create(boxGraph, UUID.generate(), selectionBox => {
            selectionBox.selectable.refer(selectable)
            selectionBox.selection.refer(userA.selection)
        })
        boxGraph.endTransaction()
        return box
    }

    // Regression for live error #1034: "Could not remove <SelectionBox>/1".
    //
    // In a live room a single (YSync / undo) transaction can BOTH delete a currently-selected box AND
    // cause the local selection to re-follow the same user (VertexSelection.switch -> re-subscribe). The
    // re-subscription takes its catch-up snapshot in the middle of the transaction, AFTER the box was
    // deleted but BEFORE endTransaction dispatches the box graph's DEFERRED pointer notifications. So the
    // fresh PointerHub.catchupAndSubscribe `added` set never records the deleted SelectionBox's `selection`
    // pointer; when the deferred onRemoved for that pointer finally fires, the unguarded `added.removeByKey`
    // used to panic, aborting the whole transaction. onAdded was already guarded against the mirror race;
    // onRemoved must be too.
    it("survives a selected box being deleted while re-subscribing in the same transaction (#1034)", () => {
        const editing = new BoxEditing(boxGraph)
        const selection = new VertexSelection(editing, boxGraph)
        selection.switch(userA.selection)
        const selectable = createSelectable()
        const selectionBox = selectDirect(selectable)
        expect(selection.isSelected(selectable)).toBe(true)
        expect(() => {
            boxGraph.beginTransaction()
            selectionBox.delete()             // defers the selection-pointer onRemoved to endTransaction
            selection.switch(userA.selection) // re-subscribe: catch-up snapshot no longer contains the box
            boxGraph.endTransaction()         // deferred onRemoved hits the fresh `added` set
        }).not.toThrow()
        expect(boxGraph.inTransaction()).toBe(false)
        expect(selection.isSelected(selectable)).toBe(false)
    })
})
