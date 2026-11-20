import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})
const navigated = vi.hoisted(() => [] as Array<string>)
vi.mock("@opendaw/lib-jsx", () => ({RouteLocation: {get: () => ({navigateTo: (path: string) => navigated.push(path)})}}))
import {RuntimeNotification, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {AssetCache, OpfsQuota} from "@opendaw/studio-core"
import {StorageFull} from "./StorageFull"

const approvals: Array<RuntimeNotification.ApproveRequest> = []
const infos: Array<RuntimeNotification.InfoRequest> = []
let answer = true
RuntimeNotifier.install({
    info: async request => {infos.push(request)},
    approve: async request => {
        approvals.push(request)
        return answer
    },
    progress: () => ({message: "", terminate: () => {}}) as unknown as RuntimeNotification.ProgressUpdater,
    notify: () => {}
} as RuntimeNotification.Notifier)

const asset = (kind: AssetCache.Kind, size: number): AssetCache.Asset => ({
    kind, id: UUID.toString(UUID.generate()), name: "x", size, storedAt: 0, usedBy: [], cached: true, inUse: false, freeable: true
})
const scanOf = (freeable: ReadonlyArray<AssetCache.Asset>, unreadable: ReadonlyArray<string> = []): AssetCache.Scan => ({
    assets: freeable, freeable, freeableSize: freeable.reduce((sum, {size}) => sum + size, 0), unreadable
})
const fakeCache = (scan: () => Promise<AssetCache.Scan>) => {
    const cleared: Array<ReadonlyArray<AssetCache.Ref>> = []
    const cache = {
        scan,
        clear: async (refs: ReadonlyArray<AssetCache.Asset>) => {
            cleared.push(refs)
            return {removed: refs, skipped: [], failed: [], size: refs.reduce((sum, {size}) => sum + size, 0)}
        }
    } as unknown as AssetCache
    return {cache, cleared}
}
const failOnce = (cached: boolean = false) => {
    let calls = 0
    return OpfsQuota.retry("samples/v2/x", async () => {
        if (++calls === 1) {throw new DOMException("No space", "QuotaExceededError")}
        return calls
    }, async () => {}, {cached})
}

describe("StorageFull", () => {
    let installed: Terminable = Terminable.Empty
    beforeEach(() => {
        approvals.length = 0
        infos.length = 0
        answer = true
        vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(console, "debug").mockImplementation(() => {})
    })
    afterEach(() => {
        installed.terminate()
        vi.restoreAllMocks()
    })

    it("names what can be deleted", () => {
        const text = StorageFull.describe(scanOf([asset("sample", 1_000_000), asset("sample", 200_000), asset("soundfont", 0)]))
        expect(text).toContain("openDAW can delete 2 library samples and 1 soundfont (1.2MB)")
        expect(text).toContain("none of your projects, templates or presets use")
        expect(text).toContain("Your own imports and recordings are never deleted.")
    })

    it("deletes exactly the scanned files on Delete & Retry and lets the save run again", async () => {
        const freeable = [asset("sample", 10), asset("soundfont", 20)]
        const {cache, cleared} = fakeCache(async () => scanOf(freeable))
        const onCleared = vi.fn()
        installed = StorageFull.install(cache, onCleared)
        expect(await failOnce()).toBe(2)
        expect(approvals.map(({approveText}) => approveText)).toEqual(["Delete & Retry"])
        expect(cleared).toEqual([freeable])
        expect(onCleared).toHaveBeenCalledOnce()
    })

    it("never asks for a library file that downloads again", async () => {
        const {cache, cleared} = fakeCache(async () => scanOf([asset("sample", 10)]))
        installed = StorageFull.install(cache, () => {})
        await expect(failOnce(true)).rejects.toThrow("No space")
        expect(approvals).toEqual([])
        expect(cleared).toEqual([])
    })

    it("asks again for every import or recording, also right after a Cancel", async () => {
        const {cache, cleared} = fakeCache(async () => scanOf([asset("sample", 10)]))
        installed = StorageFull.install(cache, () => {})
        answer = false
        await expect(failOnce(false)).rejects.toThrow("No space")
        await expect(failOnce(false)).rejects.toThrow("No space")
        expect(approvals.length).toBe(2)
        expect(cleared).toEqual([])
    })

    it("offers the storage page when there is nothing to delete", async () => {
        const {cache} = fakeCache(async () => scanOf([]))
        installed = StorageFull.install(cache, () => {})
        await expect(failOnce()).rejects.toThrow("No space")
        expect(navigated).toEqual(["/storage"])
        expect(approvals[0].approveText).toBe("Open Storage")
        expect(approvals[0].message).toContain("There are no library files that can be deleted.")
    })

    it("says why nothing is deleted while a project cannot be read", async () => {
        const {cache} = fakeCache(async () => scanOf([], ["projects/v1/a/project.od", "presets/user/b.odp"]))
        installed = StorageFull.install(cache, () => {})
        answer = false
        await expect(failOnce()).rejects.toThrow("No space")
        expect(approvals[0].message).toContain("2 projects, templates or presets could not be read")
    })

    it("gives up on a scan that never answers", async () => {
        vi.useFakeTimers()
        const {cache} = fakeCache(() => new Promise(() => {}))
        installed = StorageFull.install(cache, () => {})
        const result = failOnce().then(() => "saved", (error: Error) => error.message)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(await result).toBe("No space")
        expect(infos[0].message).toContain("The storage scan took too long")
        vi.useRealTimers()
    })

    it("tells the user and passes the error on when the scan fails", async () => {
        const {cache} = fakeCache(async () => {throw new Error("worker gone")})
        installed = StorageFull.install(cache, () => {})
        await expect(failOnce()).rejects.toThrow("No space")
        expect(approvals).toEqual([])
        expect(infos[0].message).toContain("worker gone")
    })
})
