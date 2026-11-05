import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {GrooveShuffleBox, RootBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "./TransferUtils"

const listed = (rootBox: RootBox) => rootBox.grooves.pointerHub.incoming()
    .map(pointer => pointer.box as GrooveShuffleBox)
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
})
