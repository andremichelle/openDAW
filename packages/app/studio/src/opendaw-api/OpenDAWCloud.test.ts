import {afterEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@opendaw/lib-std"

// The web app must keep fetching every catalogue exactly as before; only a host that disables the cloud
// (the desktop app) gets empty catalogues without a single request. Fresh modules per test, because the
// APIs are lazy singletons with memoized indexes.
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
    it("is available unless disabled", async () => {
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

describe("OpenDAWCloud disabled (desktop)", () => {
    afterEach(() => vi.unstubAllGlobals())
    const disabledApi = async () => {
        const fetchMock = stubFetch({version: 1, folders: []})
        const api = await freshApi()
        api.OpenDAWCloud.disable()
        return {fetchMock, ...api}
    }
    it("returns empty catalogues without any request", async () => {
        const {fetchMock, OpenSampleAPI, OpenSoundfontAPI, OpenPresetAPI, OpenWclapAPI, OpenDAWCloud} = await disabledApi()
        expect(OpenDAWCloud.isAvailable()).toBe(false)
        expect(await OpenSampleAPI.get().all()).toEqual([])
        expect(await OpenSoundfontAPI.get().all()).toEqual([])
        expect(await OpenPresetAPI.get().list()).toEqual([])
        expect(await OpenWclapAPI.get().all()).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it("fails remote loads at once without any request", async () => {
        const {fetchMock, OpenSampleAPI, OpenSoundfontAPI, OpenPresetAPI, OpenWclapAPI} = await disabledApi()
        const uuid = UUID.generate()
        await expect(OpenSampleAPI.get().get(uuid)).rejects.toThrow()
        await expect(OpenSampleAPI.get().load(uuid, () => {})).rejects.toThrow()
        await expect(OpenSoundfontAPI.get().load(uuid, () => {})).rejects.toThrow()
        await expect(OpenPresetAPI.get().load(uuid)).rejects.toThrow()
        await expect(OpenWclapAPI.get().load(UUID.toString(uuid))).rejects.toThrow()
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
