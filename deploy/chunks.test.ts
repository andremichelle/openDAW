import {describe, expect, it} from "vitest"
import {chunkFiles} from "./chunks"

describe("chunkFiles", () => {
    it("fills chunks up to the limit in order", () => {
        const files = [{path: "a", size: 6}, {path: "b", size: 4}, {path: "c", size: 3}, {path: "d", size: 7}]
        expect(chunkFiles(files, 10)).toEqual([["a", "b"], ["c", "d"]])
    })
    it("gives a file larger than the limit a chunk of its own", () => {
        const files = [{path: "small", size: 2}, {path: "huge", size: 50}, {path: "tail", size: 1}]
        expect(chunkFiles(files, 10)).toEqual([["small"], ["huge"], ["tail"]])
    })
    it("keeps every file exactly once", () => {
        const files = Array.from({length: 100}, (_, index) => ({path: `f${index}`, size: (index * 37) % 23}))
        expect(chunkFiles(files, 40).flat()).toEqual(files.map(file => file.path))
    })
    it("closes a chunk at the file count", () => {
        const files = Array.from({length: 7}, (_, index) => ({path: `f${index}`, size: 1}))
        expect(chunkFiles(files, 100, 3)).toEqual([["f0", "f1", "f2"], ["f3", "f4", "f5"], ["f6"]])
    })
    it("closes a chunk at whichever limit comes first", () => {
        const files = [{path: "a", size: 8}, {path: "b", size: 1}, {path: "c", size: 1}, {path: "d", size: 1}, {path: "e", size: 1}]
        expect(chunkFiles(files, 9, 2)).toEqual([["a", "b"], ["c", "d"], ["e"]])
        expect(chunkFiles(files, 9, 10)).toEqual([["a", "b"], ["c", "d", "e"]])
    })
    it("has no chunks without files", () => {
        expect(chunkFiles([], 10)).toEqual([])
    })
})
