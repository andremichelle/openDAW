import {beforeEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@opendaw/lib-std"

const deleted = vi.hoisted(() => ({paths: [] as Array<string>, failing: new Set<string>(), staying: new Set<string>()}))

vi.mock("../Workers", () => ({
    Workers: {
        Opfs: {
            delete: async (path: string) => {
                if (deleted.failing.has(path)) {throw new DOMException("locked", "NoModificationAllowedError")}
                if (!deleted.staying.has(path)) {deleted.paths.push(path)}
            },
            exists: async (path: string) => deleted.staying.has(path),
            read: async (path: string) => {throw new DOMException(`${path} not found`, "NotFoundError")}
        }
    }
}))

import {GlobalSampleLoaderManager} from "../samples/GlobalSampleLoaderManager"
import {GlobalSoundfontLoaderManager} from "../soundfont/GlobalSoundfontLoaderManager"
import {AssetCache} from "./AssetCache"
import {StorageScan} from "./StorageScan"

const id = (): UUID.String => UUID.toString(UUID.generate())
const Library = id(), LibraryOld = id(), Own = id(), UsedByProject = id(), UsedByPreset = id(), Loaded = id(), Font = id()
const Bundle = id(), Locked = id()

const asset = (kind: StorageScan.AssetKind, assetId: string, size: number,
               usedBy: ReadonlyArray<StorageScan.ItemRef> = [], storedAt: number = 1000): StorageScan.Asset => ({
    kind, id: assetId, name: `name-${assetId}`, size, origin: "openDAW", clapIds: [], usedBy, storedAt,
    path: `${kind === "sample" ? "samples/v2" : kind === "soundfont" ? "soundfont" : "wclap"}/${assetId}`
})

const createReport = (failures: ReadonlyArray<string> = []): StorageScan.Report => ({
    total: 0, bookkeeping: 0, items: [], other: [], failures,
    assets: [
        asset("sample", Library, 100, [], 3000),
        asset("sample", LibraryOld, 10, [], 1000),
        asset("sample", Own, 1000),
        asset("sample", UsedByProject, 200, [{kind: "project", id: "p"}]),
        asset("sample", UsedByPreset, 300, [{kind: "preset", id: "x"}]),
        asset("sample", Loaded, 400),
        asset("sample", Locked, 500),
        asset("soundfont", Font, 2000),
        asset("wclap", Bundle, 5000)
    ]
})

const setup = (failures: ReadonlyArray<string> = []) => {
    const sampleManager = new GlobalSampleLoaderManager({fetch: () => new Promise(() => {})})
    const soundfontManager = new GlobalSoundfontLoaderManager({fetch: () => new Promise(() => {})})
    const loaded = sampleManager.register(UUID.parse(Loaded))
    const cache = new AssetCache({
        sampleManager, soundfontManager,
        isCached: ({id: assetId}) => assetId !== Own,
        report: async () => createReport(failures)
    })
    return {cache, sampleManager, soundfontManager, loaded}
}
const ids = (refs: ReadonlyArray<AssetCache.Ref>) => refs.map(ref => ref.id).sort()

describe("AssetCache", () => {
    beforeEach(() => {
        deleted.paths.length = 0
        deleted.failing.clear()
        deleted.staying.clear()
    })

    describe("scan", () => {
        it("frees only cached assets that nothing stored uses and no loaded project holds", async () => {
            const {cache} = setup()
            const {freeable, freeableSize} = await cache.scan()
            expect(ids(freeable)).toEqual([Font, Library, LibraryOld, Locked].sort())
            expect(freeableSize).toBe(100 + 10 + 2000 + 500)
        })
        it("explains each asset", async () => {
            const {cache} = setup()
            const {assets} = await cache.scan()
            const of = (assetId: string) => assets.find(entry => entry.id === assetId)
            expect(of(Own)).toMatchObject({cached: false, inUse: false, freeable: false})
            expect(of(UsedByProject)).toMatchObject({cached: true, freeable: false, usedBy: [{kind: "project", id: "p"}]})
            expect(of(UsedByPreset)?.freeable).toBe(false)
            expect(of(Loaded)).toMatchObject({cached: true, inUse: true, freeable: false})
            expect(of(Library)).toMatchObject({size: 100, storedAt: 3000, name: `name-${Library}`})
        })
        it("leaves WebCLAP bundles out", async () => {
            const {cache} = setup()
            expect((await cache.scan()).assets.some(entry => entry.id === Bundle)).toBe(false)
        })
        it("skips a folder whose name is not a uuid instead of failing", async () => {
            const sampleManager = new GlobalSampleLoaderManager({fetch: () => new Promise(() => {})})
            const soundfontManager = new GlobalSoundfontLoaderManager({fetch: () => new Promise(() => {})})
            const report = createReport()
            const cache = new AssetCache({
                sampleManager, soundfontManager, isCached: () => true,
                report: async () => ({...report, assets: [...report.assets, asset("soundfont", "tmp", 1)]})
            })
            const scan = await cache.scan()
            expect(scan.assets.some(entry => String(entry.id) === "tmp")).toBe(false)
            expect(scan.freeable.length).toBeGreaterThan(0)
        })
        it("frees nothing while a project, template or preset cannot be read", async () => {
            const {cache} = setup(["projects/v1/broken/project.od"])
            const scan = await cache.scan()
            expect(scan.freeable).toEqual([])
            expect(scan.unreadable).toEqual(["projects/v1/broken/project.od"])
        })
        it("frees nothing while a preset cannot be read", async () => {
            const {cache} = setup(["presets/user/abc.odp"])
            expect((await cache.scan()).freeable).toEqual([])
        })
        it("keeps an asset whose own files could not all be read", async () => {
            const {cache} = setup([`samples/v2/${Locked}/audio.wav`])
            const scan = await cache.scan()
            expect(scan.freeable.some(entry => entry.id === Locked)).toBe(false)
            expect(scan.freeable.some(entry => entry.id === Library)).toBe(true)
            expect(scan.unreadable).toEqual([])
        })
        it("counts a sample that is being loaded right now as in use", async () => {
            const {cache, sampleManager} = setup()
            sampleManager.getOrCreate(UUID.parse(Library))
            const {assets} = await cache.scan()
            expect(assets.find(entry => entry.id === Library)).toMatchObject({inUse: true, freeable: false})
        })
        it("counts a soundfont that was requested in this session as in use", async () => {
            const {cache, soundfontManager} = setup()
            soundfontManager.getOrCreate(UUID.parse(Font))
            const {assets} = await cache.scan()
            expect(assets.find(entry => entry.id === Font)?.freeable).toBe(false)
        })
        it("waits for an asynchronous answer of the host", async () => {
            const sampleManager = new GlobalSampleLoaderManager({fetch: () => new Promise(() => {})})
            const soundfontManager = new GlobalSoundfontLoaderManager({fetch: () => new Promise(() => {})})
            const cache = new AssetCache({
                sampleManager, soundfontManager,
                isCached: async ({id: assetId}) => assetId === Library,
                report: async () => createReport()
            })
            expect(ids((await cache.scan()).freeable)).toEqual([Library])
        })
    })

    describe("clear", () => {
        it("removes the given freeable assets and skips the others", async () => {
            const {cache} = setup()
            const cleared = await cache.clear([
                {kind: "sample", id: Library}, {kind: "sample", id: Own}, {kind: "sample", id: Loaded},
                {kind: "sample", id: UsedByProject}, {kind: "soundfont", id: Font}])
            expect(deleted.paths.sort()).toEqual([`samples/v2/${Library}`, `soundfont/${Font}`].sort())
            expect(ids(cleared.removed)).toEqual([Font, Library].sort())
            expect(ids(cleared.skipped)).toEqual([Loaded, Own, UsedByProject].sort())
            expect(cleared.size).toBe(2100)
            expect(cleared.failed).toEqual([])
        })
        it("removes nothing for an empty list", async () => {
            const {cache} = setup()
            const cleared = await cache.clear([])
            expect(deleted.paths).toEqual([])
            expect(cleared.removed).toEqual([])
        })
        it("does not mix up a sample and a soundfont with the same id", async () => {
            const {cache} = setup()
            const cleared = await cache.clear([{kind: "soundfont", id: Library}])
            expect(deleted.paths).toEqual([])
            expect(ids(cleared.skipped)).toEqual([Library])
        })
        it("reports an asset it could not remove", async () => {
            const {cache} = setup()
            deleted.failing.add(`samples/v2/${Library}`)
            const cleared = await cache.clear([{kind: "sample", id: Library}, {kind: "sample", id: LibraryOld}])
            expect(ids(cleared.removed)).toEqual([LibraryOld])
            expect(cleared.failed.map(({ref}) => ref.id)).toEqual([Library])
            expect(cleared.size).toBe(10)
        })
        it("reports an asset as failed when its folder is still there after the delete", async () => {
            const {cache} = setup()
            deleted.staying.add(`samples/v2/${Library}`)
            const cleared = await cache.clear([{kind: "sample", id: Library}, {kind: "sample", id: LibraryOld}])
            expect(ids(cleared.removed)).toEqual([LibraryOld])
            expect(cleared.failed.map(({ref}) => ref.id)).toEqual([Library])
            expect(cleared.size).toBe(10)
        })
        it("skips an asset a project started to load after the scan", async () => {
            const {sampleManager, soundfontManager} = setup()
            let calls = 0
            const cache = new AssetCache({
                sampleManager, soundfontManager, isCached: () => true,
                report: async () => {
                    calls++
                    return createReport()
                }
            })
            const original = cache.scan.bind(cache)
            vi.spyOn(cache, "scan").mockImplementation(async () => {
                const scan = await original()
                sampleManager.register(UUID.parse(Library))
                return scan
            })
            const cleared = await cache.clear([{kind: "sample", id: Library}])
            expect(calls).toBe(1)
            expect(deleted.paths).toEqual([])
            expect(ids(cleared.skipped)).toEqual([Library])
        })
    })

    describe("clearAll", () => {
        it("removes every freeable asset", async () => {
            const {cache} = setup()
            const cleared = await cache.clearAll([])
            expect(ids(cleared.removed)).toEqual([Font, Library, LibraryOld, Locked].sort())
            expect(deleted.paths.length).toBe(4)
        })
        it("keeps the excluded assets", async () => {
            const {cache} = setup()
            const cleared = await cache.clearAll([{kind: "sample", id: Library}, {kind: "soundfont", id: Font}])
            expect(ids(cleared.removed)).toEqual([LibraryOld, Locked].sort())
            expect(deleted.paths.sort()).toEqual([`samples/v2/${LibraryOld}`, `samples/v2/${Locked}`].sort())
        })
        it("removes nothing an unreadable project might use", async () => {
            const {cache} = setup(["templates/v1/t/project.od"])
            expect((await cache.clearAll([])).removed).toEqual([])
            expect(deleted.paths).toEqual([])
        })
        it("never removes an asset that is not cached, used or loaded", async () => {
            const {cache} = setup()
            await cache.clearAll([])
            for (const assetId of [Own, UsedByProject, UsedByPreset, Loaded]) {
                expect(deleted.paths.some(path => path.endsWith(assetId))).toBe(false)
            }
        })
    })
})
