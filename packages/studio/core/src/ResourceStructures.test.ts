import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ResourceStructure} from "./StructureFile"
import {ResourceStructures} from "./ResourceStructures"

const [A, B, C, D] = ["a", "b", "c", "d"].map(letter => `${letter.repeat(8)}-0000-4000-8000-000000000000` as UUID.String)
const empty: ResourceStructure = {version: 1, folders: [], trash: []}

describe("ResourceStructures.place", () => {
    it("creates the folders of the path", () => {
        expect(ResourceStructures.place(empty, ["Multi Samples", "Piano"], [A, B]).folders)
            .toEqual([{name: "Multi Samples", folders: [{name: "Piano", uuids: [A, B]}]}])
    })
    it("adds to a folder that exists and leaves its neighbours alone", () => {
        const structure: ResourceStructure = {
            version: 1, trash: [],
            folders: [{name: "Drums", uuids: [D]}, {name: "Multi Samples", folders: [{name: "Organ", uuids: [C]}, {name: "Piano", uuids: [A]}]}]
        }
        expect(ResourceStructures.place(structure, ["Multi Samples", "Piano"], [B]).folders).toEqual([
            {name: "Drums", uuids: [D]},
            {name: "Multi Samples", folders: [{name: "Organ", uuids: [C]}, {name: "Piano", uuids: [A, B]}]}
        ])
    })
    it("leaves an item where the user already has it, in a folder or in the trash", () => {
        const structure: ResourceStructure = {version: 1, folders: [{name: "Mine", uuids: [A]}], trash: [{uuid: B, path: "Old"}]}
        expect(ResourceStructures.place(structure, ["Multi Samples"], [A, B, C]).folders)
            .toEqual([{name: "Mine", uuids: [A]}, {name: "Multi Samples", uuids: [C]}])
    })
    it("adds an item once however often it is given", () => {
        expect(ResourceStructures.place(empty, ["x"], [A, A, B, A]).folders).toEqual([{name: "x", uuids: [A, B]}])
    })
    it("changes nothing without a path or without new items", () => {
        const structure: ResourceStructure = {version: 1, folders: [{name: "Mine", uuids: [A]}], trash: []}
        expect(ResourceStructures.place(structure, [], [B])).toBe(structure)
        expect(ResourceStructures.place(structure, ["x"], [])).toBe(structure)
        expect(ResourceStructures.place(structure, ["x"], [A])).toBe(structure)
    })
    it("does not touch the structure it was given", () => {
        const structure: ResourceStructure = {version: 1, folders: [{name: "x", uuids: [A]}], trash: []}
        ResourceStructures.place(structure, ["x"], [B])
        expect(structure.folders).toEqual([{name: "x", uuids: [A]}])
    })
})
