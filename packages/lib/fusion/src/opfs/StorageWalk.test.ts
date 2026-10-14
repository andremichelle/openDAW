import {describe, expect, it} from "vitest"
import {StorageWalk} from "./StorageWalk"

type Tree = { [name: string]: Tree | Leaf }
type Leaf = Uint8Array | "locked"

const directory = (name: string, tree: Tree): FileSystemDirectoryHandle => ({
    kind: "directory", name,
    async* values() {
        for (const [child, entry] of Object.entries(tree)) {
            yield entry instanceof Uint8Array || entry === "locked"
                ? {
                    kind: "file", name: child,
                    getFile: async () => entry === "locked"
                        ? Promise.reject(new DOMException("locked", "NoModificationAllowedError"))
                        : new File([entry.slice()], child)
                }
                : directory(child, entry)
        }
    }
}) as unknown as FileSystemDirectoryHandle

const bytes = (length: number) => new Uint8Array(length)

describe("StorageWalk", () => {
    const tree: Tree = {
        projects: {v1: {a: {"project.od": bytes(100), "meta.json": bytes(10)}, "trash.json": bytes(2)}},
        samples: {v2: {s: {"audio.wav": bytes(1000), "peaks.bin": bytes(50)}}},
        ".backup": {"project.od": "locked"},
        "loose.bin": bytes(7)
    }

    it("collects every file with its path and size", async () => {
        const {files, failures} = await StorageWalk.walk(directory("", tree), () => {})
        expect(files.map(({path, size}) => `${path}:${size}`).sort()).toEqual([
            "loose.bin:7",
            "projects/v1/a/meta.json:10",
            "projects/v1/a/project.od:100",
            "projects/v1/trash.json:2",
            "samples/v2/s/audio.wav:1000",
            "samples/v2/s/peaks.bin:50"
        ])
        expect(failures).toEqual([".backup/project.od"])
        expect(StorageWalk.totalSize(files)).toBe(1169)
    })

    it("reports the final count as progress", async () => {
        const counts: Array<number> = []
        await StorageWalk.walk(directory("", tree), count => counts.push(count))
        expect(counts.at(-1)).toBe(6)
    })

    it("returns nothing for an empty root", async () => {
        const result = await StorageWalk.walk(directory("", {}), () => {})
        expect(result).toEqual({files: [], failures: []})
    })
})
