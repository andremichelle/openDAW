import {afterEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@opendaw/lib-std"

// The web app must keep fetching every catalogue exactly as before; only a host that follows the network
// (the desktop app) gets empty catalogues without a single request while offline, and fetches them once online.
// Fresh modules per test, because the APIs are lazy singletons with memoized indexes.
const freshApi = async () => {
    vi.resetModules()
    return import("./index")
}

const stubFetch = (json: unknown) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(json), {status: 200}))
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
}

const requestedUrls = (fetchMock: ReturnType<typeof stubFetch>): ReadonlyArray<string> =>
    fetchMock.mock.calls.map((call: ReadonlyArray<unknown>) => String(call[0]))

describe("OpenDAWCloud available (web default)", () => {
    afterEach(() => vi.unstubAllGlobals())
    it("is available even offline unless it follows the network", async () => {
        vi.stubGlobal("navigator", {onLine: false})
        const {OpenDAWCloud} = await freshApi()
        expect(OpenDAWCloud.isAvailable()).toBe(true)
    })
    it("fetches the sample index", async () => {
        const fetchMock = stubFetch({version: 1, folders: []})
        const {OpenSampleAPI} = await freshApi()
        expect(await OpenSampleAPI.get().all()).toEqual([])
        expect(requestedUrls(fetchMock).some(url => url.startsWith(OpenSampleAPI.IndexFile))).toBe(true)
    })
    it("fetches the soundfont index", async () => {
        const fetchMock = stubFetch({version: 1, folders: []})
        const {OpenSoundfontAPI} = await freshApi()
        expect(await OpenSoundfontAPI.get().all()).toEqual([])
        expect(requestedUrls(fetchMock).some(url => url.startsWith(OpenSoundfontAPI.IndexFile))).toBe(true)
    })
    it("fetches the preset list", async () => {
        const fetchMock = stubFetch([])
        const {OpenPresetAPI} = await freshApi()
        expect(await OpenPresetAPI.get().list()).toEqual([])
        expect(requestedUrls(fetchMock).some(url => url.startsWith(`${OpenPresetAPI.FileRoot}/index.json`))).toBe(true)
    })
    it("fetches the WebCLAP index", async () => {
        const fetchMock = stubFetch({version: 1, folders: []})
        const {OpenWclapAPI} = await freshApi()
        await OpenWclapAPI.get().tree()
        expect(requestedUrls(fetchMock).some(url => url.startsWith(OpenWclapAPI.IndexFile))).toBe(true)
    })
})

describe("OpenDAWCloud follows the network (desktop)", () => {
    afterEach(() => vi.unstubAllGlobals())
    const networkApi = async (onLine: boolean) => {
        const network = {onLine}
        vi.stubGlobal("navigator", network)
        const fetchMock = stubFetch({version: 1, folders: []})
        const api = await freshApi()
        api.OpenDAWCloud.followNetwork()
        return {network, fetchMock, ...api}
    }
    it("returns empty catalogues offline without any request", async () => {
        const {fetchMock, OpenSampleAPI, OpenSoundfontAPI, OpenPresetAPI, OpenWclapAPI, OpenDAWCloud} = await networkApi(false)
        expect(OpenDAWCloud.isAvailable()).toBe(false)
        expect(await OpenSampleAPI.get().all()).toEqual([])
        expect(await OpenSoundfontAPI.get().all()).toEqual([])
        expect(await OpenPresetAPI.get().list()).toEqual([])
        expect(await OpenWclapAPI.get().all()).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it("fails remote loads offline at once without any request", async () => {
        const {fetchMock, OpenSampleAPI, OpenSoundfontAPI, OpenPresetAPI, OpenWclapAPI} = await networkApi(false)
        const uuid = UUID.generate()
        await expect(OpenSampleAPI.get().get(uuid)).rejects.toThrow()
        await expect(OpenSampleAPI.get().load(uuid, () => {})).rejects.toThrow()
        await expect(OpenSoundfontAPI.get().load(uuid, () => {})).rejects.toThrow()
        await expect(OpenPresetAPI.get().load(uuid)).rejects.toThrow()
        await expect(OpenWclapAPI.get().load(UUID.toString(uuid))).rejects.toThrow()
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it("fetches the catalogues online", async () => {
        const {fetchMock, OpenSampleAPI, OpenSoundfontAPI, OpenPresetAPI, OpenWclapAPI} = await networkApi(true)
        await OpenSampleAPI.get().all()
        await OpenSoundfontAPI.get().all()
        await OpenPresetAPI.get().list()
        await OpenWclapAPI.get().all()
        const urls = requestedUrls(fetchMock)
        expect([OpenSampleAPI.IndexFile, OpenSoundfontAPI.IndexFile, `${OpenPresetAPI.FileRoot}/index.json`, OpenWclapAPI.IndexFile]
            .every(file => urls.some(url => url.startsWith(file)))).toBe(true)
    })
    it("fetches a catalogue on its next use once back online", async () => {
        const {network, fetchMock, OpenSampleAPI, OpenPresetAPI} = await networkApi(false)
        expect(await OpenSampleAPI.get().all()).toEqual([])
        expect(await OpenPresetAPI.get().list()).toEqual([])
        network.onLine = true
        fetchMock.mockImplementation(async (input: unknown) => new Response(JSON.stringify(String(input).includes("/presets/")
            ? [] : {version: 1, folders: [{name: "Drums", samples: []}]}), {status: 200}))
        expect((await OpenSampleAPI.get().tree()).folders.map(folder => folder.name)).toEqual(["Drums"])
        await OpenPresetAPI.get().list()
        expect(requestedUrls(fetchMock).some(url => url.startsWith(`${OpenPresetAPI.FileRoot}/index.json`))).toBe(true)
    })
    // the missing-file check reads the catalogue: an unreachable one must not look like an empty one
    it("fails the catalogue offline without any request, the browsers still get empty lists", async () => {
        const {fetchMock, OpenSampleAPI, OpenSoundfontAPI} = await networkApi(false)
        await expect(OpenSampleAPI.get().catalogue()).rejects.toThrow()
        await expect(OpenSoundfontAPI.get().catalogue()).rejects.toThrow()
        expect(await OpenSampleAPI.get().all()).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it("fails the catalogue when the index cannot be fetched while online", async () => {
        const {fetchMock, OpenSampleAPI, OpenSoundfontAPI} = await networkApi(true)
        fetchMock.mockImplementation(async () => {throw new TypeError("Load failed")})
        await expect(OpenSampleAPI.get().catalogue()).rejects.toThrow()
        await expect(OpenSoundfontAPI.get().catalogue()).rejects.toThrow()
        expect(await OpenSoundfontAPI.get().all()).toEqual([])
    })
    it("lists the catalogue when the index arrives", async () => {
        const {OpenSampleAPI} = await networkApi(true)
        expect(await OpenSampleAPI.get().catalogue()).toEqual([])
    })
})
