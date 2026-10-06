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
            write: async (path: string, bytes: Uint8Array) => {files.set(path, bytes.slice())}
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
})
