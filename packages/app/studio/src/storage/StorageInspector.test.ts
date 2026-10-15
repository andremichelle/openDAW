import {afterEach, describe, expect, it, vi} from "vitest"
import {EmptyProcedure} from "@opendaw/lib-std"
import {StorageScan} from "./StorageScan"

// The desktop app reads its own data directory, the web keeps walking OPFS. Fresh module per test, install mutates it.
const freshInspector = async () => {
    vi.resetModules()
    return (await import("./StorageInspector")).StorageInspector
}

describe("StorageInspector", () => {
    afterEach(() => vi.unstubAllGlobals())
    it("estimates with navigator.storage by default", async () => {
        const StorageInspector = await freshInspector()
        const estimate = vi.fn(async () => ({usage: 1, quota: 2}))
        vi.stubGlobal("navigator", {storage: {estimate}})
        expect(await StorageInspector.estimate()).toEqual({usage: 1, quota: 2})
        expect(estimate).toHaveBeenCalledTimes(1)
    })
    it("uses installed strategies", async () => {
        const StorageInspector = await freshInspector()
        vi.stubGlobal("navigator", {})
        const report = {total: 42} as unknown as StorageScan.Report
        StorageInspector.install({
            scan: async () => report,
            folderSize: async (path: string) => path.length,
            estimate: async () => ({usage: 3, quota: 4})
        })
        expect(await StorageInspector.scan(EmptyProcedure, EmptyProcedure)).toBe(report)
        expect(await StorageInspector.folderSize("samples/v2")).toBe(10)
        expect(await StorageInspector.estimate()).toEqual({usage: 3, quota: 4})
    })
})
