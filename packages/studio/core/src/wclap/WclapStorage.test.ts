import {afterEach, describe, expect, it, vi} from "vitest"

const files = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock("../Workers", () => ({
    Workers: {
        Opfs: {
            exists: async (path: string) => files.has(path),
            read: async (path: string) => {
                const bytes = files.get(path)
                if (bytes === undefined) {throw new Error(`NotFound ${path}`)}
                return bytes
            },
            write: async (path: string, bytes: Uint8Array) => {files.set(path, bytes.slice())},
            delete: async (path: string) => {
                Array.from(files.keys()).filter(key => key === path || key.startsWith(`${path}/`)).forEach(key => files.delete(key))
            },
            list: async (folder: string) => Array.from(files.keys())
                .filter(path => path.startsWith(`${folder}/`))
                .map(path => path.substring(folder.length + 1).split("/"))
                .map(segments => ({name: segments[0], kind: segments.length > 1 ? "directory" : "file"}))
                .filter((entry, index, all) => all.findIndex(other => other.name === entry.name) === index)
        }
    }
}))

import {WclapStorage} from "./WclapStorage"

const archive = new Uint8Array(1000).map((_, index) => index * 13).buffer
const other = new Uint8Array(1000).map((_, index) => index * 17).buffer

describe("WclapStorage", () => {
    afterEach(() => {
        files.clear()
        WclapStorage.installRemote(undefined)
    })

    it("loads a stored bundle without asking the remote", async () => {
        const url = await WclapStorage.store(archive)
        const remote = vi.fn(async () => other)
        WclapStorage.installRemote(remote)
        expect(new Uint8Array(await WclapStorage.load(url))).toStrictEqual(new Uint8Array(archive))
        expect(remote).not.toHaveBeenCalled()
    })

    it("fetches a missing bundle from the remote and stores it when its hash matches the url", async () => {
        const url = await WclapStorage.urlFor(archive)
        WclapStorage.installRemote(async () => archive.slice(0))
        expect(new Uint8Array(await WclapStorage.load(url))).toStrictEqual(new Uint8Array(archive))
        expect(await WclapStorage.exists(WclapStorage.idOf(url))).toBe(true)
    })

    it("rejects a remote bundle whose hash does not match the url and stores nothing", async () => {
        const url = await WclapStorage.urlFor(archive)
        WclapStorage.installRemote(async () => other)
        await expect(WclapStorage.load(url)).rejects.toThrow()
        expect(files.size).toBe(0)
    })

    it("rejects a missing bundle when there is no remote", async () => {
        const url = await WclapStorage.urlFor(archive)
        await expect(WclapStorage.load(url)).rejects.toThrow()
    })

    it("remembers when a bundle was stored", async () => {
        vi.useFakeTimers({toFake: ["Date"], now: 1000})
        const id = WclapStorage.idOf(await WclapStorage.store(archive))
        expect(await WclapStorage.storedAt(id)).toBe(1000)
        await WclapStorage.save(id, archive, 500)
        expect(await WclapStorage.storedAt(id)).toBe(500)
        vi.useRealTimers()
    })

    it("deletes a bundle for good and leaves a tombstone with the deletion time", async () => {
        vi.useFakeTimers({toFake: ["Date"], now: 2000})
        const kept = WclapStorage.idOf(await WclapStorage.store(other))
        const id = WclapStorage.idOf(await WclapStorage.store(archive))
        await WclapStorage.remove(id)
        expect(await WclapStorage.exists(id)).toBe(false)
        expect(await WclapStorage.list()).toStrictEqual([kept])
        expect(await WclapStorage.tombstones()).toStrictEqual({[id]: 2000})
        vi.useRealTimers()
    })

    it("merges tombstones by keeping the latest deletion per id", async () => {
        await WclapStorage.writeTombstones({a: 10, b: 30})
        await WclapStorage.writeTombstones(WclapStorage.mergeTombstones(await WclapStorage.tombstones(), {a: 20, b: 5, c: 1}))
        expect(await WclapStorage.tombstones()).toStrictEqual({a: 20, b: 30, c: 1})
    })
})
