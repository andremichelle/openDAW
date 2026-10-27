import {afterAll, beforeAll, describe, expect, it, vi} from "vitest"
import {WclapCatalog} from "./WclapCatalog"
import {OpenWclapAPI} from "./OpenWclapAPI"
import {CommunityAPI} from "./CommunityAPI"

const Cloud = "11111111-1111-4111-8111-111111111111"
const CloudDropped = "22222222-2222-4222-8222-222222222222"
const Community = "33333333-3333-4333-8333-333333333333"
const CommunityDropped = "44444444-4444-4444-8444-444444444444"
const Unknown = "55555555-5555-4555-8555-555555555555"

const entry = (uuid: string, supersedes: ReadonlyArray<string>) => ({
    uuid, name: uuid, size: 4, url: "", credits: "", license: "MIT",
    plugins: [{clapId: "test", name: "Test", vendor: "Test", features: []}], supersedes
})

// the index lists only the latest build of each plugin, the files of the builds it superseded stay on the server
const routes: Record<string, string> = {
    [OpenWclapAPI.IndexFile]: JSON.stringify({version: 1, folders: [{name: "Cloud", wclaps: [entry(Cloud, [CloudDropped])]}]}),
    [CommunityAPI.WclapsIndexFile]: JSON.stringify({version: 1, folders: [{name: "Community", wclaps: [entry(Community, [CommunityDropped])]}]}),
    [`${OpenWclapAPI.FileRoot}/${Cloud}.wclap`]: "cloud",
    [`${OpenWclapAPI.FileRoot}/${CloudDropped}.wclap`]: "cloud-dropped",
    [`${CommunityAPI.FileRoot}/wclaps/${Community}.wclap`]: "community",
    [`${CommunityAPI.FileRoot}/wclaps/${CommunityDropped}.wclap`]: "community-dropped"
}

const requested: Array<string> = []

const text = async (archive: Promise<ArrayBuffer>): Promise<string> => new TextDecoder().decode(await archive)

describe("WclapCatalog.load", () => {
    beforeAll(() => {
        vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
            const url = input.split("?")[0]
            requested.push(url)
            const body = routes[url]
            return body === undefined ? new Response("missing", {status: 404}) : new Response(body, {status: 200})
        })
    })
    afterAll(() => vi.unstubAllGlobals())
    it("loads listed builds from where they are published", async () => {
        expect(await text(WclapCatalog.get().load(Cloud))).toBe("cloud")
        expect(await text(WclapCatalog.get().load(Community))).toBe("community")
    })
    it("loads a superseded cloud build that left the index", async () => {
        expect(await text(WclapCatalog.get().load(CloudDropped))).toBe("cloud-dropped")
    })
    it("loads a superseded community build that left the index", async () => {
        expect(await text(WclapCatalog.get().load(CommunityDropped))).toBe("community-dropped")
    })
    it("rejects an id that is on neither server, asking each once", async () => {
        requested.length = 0
        await expect(WclapCatalog.get().load(Unknown)).rejects.toThrow("HTTP 404")
        expect(requested.filter(url => url.includes(Unknown))).toEqual([
            `${OpenWclapAPI.FileRoot}/${Unknown}.wclap`,
            `${CommunityAPI.FileRoot}/wclaps/${Unknown}.wclap`
        ])
    })
})
