import {beforeEach, describe, expect, it, vi} from "vitest"
import {OpfsProtocol} from "./OpfsProtocol"

type FileData = { kind: "file", data: Uint8Array }
type DirData = { kind: "directory", children: Map<string, FileData | DirData> }
type EntryData = FileData | DirData

const createMockFileSystem = () => {
    const root: Map<string, EntryData> = new Map()
    const resolveDir = (segments: ReadonlyArray<string>, create: boolean): Map<string, EntryData> => {
        let current = root
        for (const segment of segments) {
            const entry = current.get(segment)
            if (entry === undefined) {
                if (!create) {throw new DOMException("Not found", "NotFoundError")}
                const dir: DirData = {kind: "directory", children: new Map()}
                current.set(segment, dir)
                current = dir.children
            } else if (entry.kind === "directory") {
                current = entry.children
            } else {
                throw new DOMException("Not a directory", "TypeMismatchError")
            }
        }
        return current
    }
    const createSyncAccessHandle = (fileEntry: FileData): FileSystemSyncAccessHandle => ({
        getSize: () => fileEntry.data.length,
        read: (buffer: Uint8Array) => {
            buffer.set(fileEntry.data.subarray(0, buffer.length))
            return Math.min(buffer.length, fileEntry.data.length)
        },
        write: (buffer: ArrayBuffer, options?: {at?: number}) => {
            const src = new Uint8Array(buffer)
            const at = options?.at ?? 0
            if (at + src.length > fileEntry.data.length) {
                const newData = new Uint8Array(at + src.length)
                newData.set(fileEntry.data)
                fileEntry.data = newData
            }
            fileEntry.data.set(src, at)
            return src.length
        },
        truncate: (size: number) => {fileEntry.data = new Uint8Array(size)},
        flush: () => {},
        close: () => {}
    } as unknown as FileSystemSyncAccessHandle)
    const createFileHandle = (name: string, fileEntry: FileData): FileSystemFileHandle => ({
        kind: "file",
        name,
        isSameEntry: async (_other: FileSystemHandle) => false,
        getFile: async () => new File([fileEntry.data.slice()], name),
        createSyncAccessHandle: async () => createSyncAccessHandle(fileEntry)
    } as unknown as FileSystemFileHandle)
    const createDirectoryHandle = (children: Map<string, EntryData>, dirName: string = ""): FileSystemDirectoryHandle => {
        const handle: FileSystemDirectoryHandle = {
            kind: "directory",
            name: dirName,
            isSameEntry: async (_other: FileSystemHandle) => false,
            async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
                const entry = children.get(name)
                if (entry === undefined) {
                    if (!options?.create) {throw new DOMException("Not found", "NotFoundError")}
                    const dir: DirData = {kind: "directory", children: new Map()}
                    children.set(name, dir)
                    return createDirectoryHandle(dir.children, name)
                }
                if (entry.kind !== "directory") {throw new DOMException("Not a directory", "TypeMismatchError")}
                return createDirectoryHandle(entry.children, name)
            },
            async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
                let entry = children.get(name)
                if (entry === undefined) {
                    if (!options?.create) {throw new DOMException("Not found", "NotFoundError")}
                    entry = {kind: "file", data: new Uint8Array(0)}
                    children.set(name, entry)
                }
                if (entry.kind !== "file") {throw new DOMException("Not a file", "TypeMismatchError")}
                return createFileHandle(name, entry)
            },
            async removeEntry(name: string, _options?: FileSystemRemoveOptions) {
                children.delete(name)
            },
            async *values() {
                for (const [name, entry] of children) {
                    yield (entry.kind === "file"
                        ? createFileHandle(name, entry)
                        : createDirectoryHandle(entry.children, name)) as any
                }
            },
            async *entries() {
                for (const [name, entry] of children) {
                    yield [name, entry.kind === "file"
                        ? createFileHandle(name, entry)
                        : createDirectoryHandle(entry.children)] as any
                }
            },
            async *keys() {
                for (const [name] of children) {yield name}
            },
            resolve: async () => null
        } as unknown as FileSystemDirectoryHandle
        return handle
    }
    return {root, createDirectoryHandle: () => createDirectoryHandle(root)}
}

let protocol: OpfsProtocol
let mockFs: ReturnType<typeof createMockFileSystem>

vi.mock("@opendaw/lib-runtime", async () => {
    const actual = await vi.importActual<typeof import("@opendaw/lib-runtime")>("@opendaw/lib-runtime")
    return {
        ...actual,
        Communicator: {
            ...actual.Communicator,
            executor: (_messenger: any, proto: any) => {
                protocol = proto
                return proto
            }
        }
    }
})

beforeEach(async () => {
    mockFs = createMockFileSystem()
    vi.stubGlobal("navigator", {
        storage: {getDirectory: async () => mockFs.createDirectoryHandle()}
    })
    const {OpfsWorker} = await import("./OpfsWorker")
    OpfsWorker.init({channel: () => ({})} as any)
})

describe("OpfsWorker", () => {
    describe("write", () => {
        it("should write data to a new file", async () => {
            const data = new Uint8Array([1, 2, 3, 4])
            await protocol.write("test.bin", data)
            const entry = mockFs.root.get("test.bin") as FileData
            expect(entry).toBeDefined()
            expect(entry.kind).toBe("file")
            expect(Array.from(entry.data)).toEqual([1, 2, 3, 4])
        })
        it("should create intermediate directories", async () => {
            const data = new Uint8Array([10, 20])
            await protocol.write("a/b/c.bin", data)
            const dirA = mockFs.root.get("a") as DirData
            expect(dirA.kind).toBe("directory")
            const dirB = dirA.children.get("b") as DirData
            expect(dirB.kind).toBe("directory")
            const file = dirB.children.get("c.bin") as FileData
            expect(Array.from(file.data)).toEqual([10, 20])
        })
        it("should overwrite existing file data", async () => {
            await protocol.write("overwrite.bin", new Uint8Array([1, 2, 3]))
            await protocol.write("overwrite.bin", new Uint8Array([4, 5]))
            const entry = mockFs.root.get("overwrite.bin") as FileData
            expect(Array.from(entry.data)).toEqual([4, 5])
        })
        it("should handle empty data", async () => {
            await protocol.write("empty.bin", new Uint8Array(0))
            const entry = mockFs.root.get("empty.bin") as FileData
            expect(entry.data.length).toBe(0)
        })
    })

    describe("read", () => {
        it("should read file contents", async () => {
            await protocol.write("readable.bin", new Uint8Array([7, 8, 9]))
            const result = await protocol.read("readable.bin")
            expect(Array.from(result)).toEqual([7, 8, 9])
        })
        it("should read from nested paths", async () => {
            await protocol.write("dir/sub/file.bin", new Uint8Array([42]))
            const result = await protocol.read("dir/sub/file.bin")
            expect(Array.from(result)).toEqual([42])
        })
        it("should reject for non-existent file", async () => {
            await expect(protocol.read("missing.bin")).rejects.toThrow()
        })
    })

    describe("exists", () => {
        it("should return true for non-empty file", async () => {
            await protocol.write("present.bin", new Uint8Array([1]))
            expect(await protocol.exists("present.bin")).toBe(true)
        })
        it("should return false for empty file", async () => {
            await protocol.write("zero.bin", new Uint8Array(0))
            expect(await protocol.exists("zero.bin")).toBe(false)
        })
        it("should reject for non-existent file", async () => {
            await expect(protocol.exists("ghost.bin")).rejects.toThrow()
        })
        it("should reject when path is a directory", async () => {
            await protocol.write("dir/file.bin", new Uint8Array([1]))
            await expect(protocol.exists("dir")).rejects.toThrow()
        })
    })

    describe("delete", () => {
        it("should delete a file", async () => {
            await protocol.write("doomed.bin", new Uint8Array([1]))
            await protocol.delete("doomed.bin")
            expect(mockFs.root.has("doomed.bin")).toBe(false)
        })
        it("should delete a nested file", async () => {
            await protocol.write("x/y/z.bin", new Uint8Array([1]))
            await protocol.delete("x/y/z.bin")
            const dirX = mockFs.root.get("x") as DirData
            const dirY = dirX.children.get("y") as DirData
            expect(dirY.children.has("z.bin")).toBe(false)
        })
        it("should delete a directory recursively", async () => {
            await protocol.write("rm/a.bin", new Uint8Array([1]))
            await protocol.write("rm/sub/b.bin", new Uint8Array([2]))
            await protocol.delete("rm")
            expect(mockFs.root.has("rm")).toBe(false)
        })
        it("should not throw for non-existent path", async () => {
            await expect(protocol.delete("nope/nothing")).resolves.toBeUndefined()
        })
        it("should clear all when given empty path", async () => {
            await protocol.write("a.bin", new Uint8Array([1]))
            await protocol.write("b.bin", new Uint8Array([2]))
            await protocol.delete("")
            expect(mockFs.root.size).toBe(0)
        })
    })

    describe("list", () => {
        it("should list entries in a directory", async () => {
            await protocol.write("folder/a.bin", new Uint8Array([1]))
            await protocol.write("folder/b.bin", new Uint8Array([2]))
            const entries = await protocol.list("folder")
            const names = entries.map(entry => entry.name).sort()
            expect(names).toEqual(["a.bin", "b.bin"])
            expect(entries.every(entry => entry.kind === "file")).toBe(true)
        })
        it("should list subdirectories", async () => {
            await protocol.write("parent/child/file.bin", new Uint8Array([1]))
            const entries = await protocol.list("parent")
            expect(entries).toEqual([{name: "child", kind: "directory"}])
        })
        it("should return empty array for non-existent directory", async () => {
            const entries = await protocol.list("nonexistent")
            expect(entries).toEqual([])
        })
        it("should list root when given empty path", async () => {
            await protocol.write("root1.bin", new Uint8Array([1]))
            await protocol.write("root2.bin", new Uint8Array([2]))
            const entries = await protocol.list("")
            expect(entries.length).toBe(2)
        })
    })

    describe("clear", () => {
        it("should remove all files and directories from root", async () => {
            await protocol.write("file1.bin", new Uint8Array([1]))
            await protocol.write("dir/file2.bin", new Uint8Array([2]))
            await protocol.delete("")
            expect(mockFs.root.size).toBe(0)
        })
    })

    describe("locking", () => {
        it("should serialize concurrent operations on the same path", async () => {
            const order: number[] = []
            const op1 = protocol.write("locked.bin", new Uint8Array([1])).then(() => order.push(1))
            const op2 = protocol.write("locked.bin", new Uint8Array([2])).then(() => order.push(2))
            await Promise.all([op1, op2])
            expect(order).toEqual([1, 2])
        })
        it("should allow concurrent operations on different paths", async () => {
            const results: string[] = []
            const op1 = protocol.write("a.bin", new Uint8Array([1])).then(() => results.push("a"))
            const op2 = protocol.write("b.bin", new Uint8Array([2])).then(() => results.push("b"))
            await Promise.all([op1, op2])
            expect(results).toHaveLength(2)
            expect(results).toContain("a")
            expect(results).toContain("b")
        })
    })

    describe("path parsing", () => {
        it("should handle leading and trailing slashes", async () => {
            await protocol.write("/slashed/file.bin/", new Uint8Array([1]))
            const result = await protocol.read("/slashed/file.bin/")
            expect(Array.from(result)).toEqual([1])
        })
        it("should handle deeply nested paths", async () => {
            await protocol.write("a/b/c/d/e/f.bin", new Uint8Array([99]))
            const result = await protocol.read("a/b/c/d/e/f.bin")
            expect(Array.from(result)).toEqual([99])
        })
    })
})
