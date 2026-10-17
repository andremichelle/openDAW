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
    it("has no chunks without files", () => {
        expect(chunkFiles([], 10)).toEqual([])
    })
})
