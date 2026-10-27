import {describe, expect, it} from "vitest"
import {ScriptLink, ScriptLinkFile} from "./ScriptLink"
import {CommunityIndex} from "./CommunityIndex"

const commons = (ref: string, path: string): ScriptLinkFile => ({owner: "andremichelle", repo: "opendaw-commons", ref, path})

// answers from a map of url -> body, anything else is a 404
const fakeFetch = (routes: Record<string, unknown>) => async (url: string): Promise<Response> => {
    const body = routes[url]
    if (body === undefined) {return new Response("missing", {status: 404})}
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {status: 200})
}

describe("ScriptLink.parse", () => {
    it("reads github.com blob links", () => {
        expect(ScriptLink.parse("https://github.com/andremichelle/opendaw-commons/blob/main/scripts/apparat/tonematrix/script.js").unwrap())
            .toEqual({kind: "file", file: commons("main", "scripts/apparat/tonematrix/script.js")})
    })
    it("keeps slashes in branch names when the path is in the commons layout", () => {
        expect(ScriptLink.parse("https://github.com/jane/opendaw-commons/blob/feature/new-synth/scripts/apparat/my-synth/script.js").unwrap())
            .toEqual({kind: "file", file: {owner: "jane", repo: "opendaw-commons", ref: "feature/new-synth", path: "scripts/apparat/my-synth/script.js"}})
    })
    it("reads tree links to an item folder", () => {
        expect(ScriptLink.parse("https://github.com/andremichelle/opendaw-commons/tree/main/scripts/project/acid").unwrap())
            .toEqual({kind: "folder", file: commons("main", "scripts/project/acid")})
    })
    it("reads raw links, with and without refs/heads", () => {
        expect(ScriptLink.parse("https://raw.githubusercontent.com/andremichelle/opendaw-commons/main/scripts/werkstatt/xy-filter/script.js").unwrap())
            .toEqual({kind: "file", file: commons("main", "scripts/werkstatt/xy-filter/script.js")})
        expect(ScriptLink.parse("https://raw.githubusercontent.com/andremichelle/opendaw-commons/refs/heads/main/scripts/werkstatt/xy-filter/script.js").unwrap())
            .toEqual({kind: "file", file: commons("main", "scripts/werkstatt/xy-filter/script.js")})
    })
    it("reads pull request links, also deeper ones", () => {
        expect(ScriptLink.parse("https://github.com/andremichelle/opendaw-commons/pull/12").unwrap())
            .toEqual({kind: "pull", owner: "andremichelle", repo: "opendaw-commons", number: 12})
        expect(ScriptLink.parse("https://github.com/andremichelle/opendaw-commons/pull/12/files").unwrap())
            .toEqual({kind: "pull", owner: "andremichelle", repo: "opendaw-commons", number: 12})
    })
    it("reads files outside the commons layout with a single segment ref", () => {
        expect(ScriptLink.parse("https://github.com/jane/sketches/blob/main/synths/fm.js").unwrap())
            .toEqual({kind: "file", file: {owner: "jane", repo: "sketches", ref: "main", path: "synths/fm.js"}})
    })
    it("tolerates surrounding whitespace", () => {
        expect(ScriptLink.parse("  https://github.com/andremichelle/opendaw-commons/pull/3 \n").nonEmpty()).toBe(true)
    })
    it("rejects everything else", () => {
        for (const link of [
            "", "not a url", "http://github.com/a/b/blob/main/x.js", "https://gitlab.com/a/b/blob/main/x.js",
            "https://github.com/andremichelle", "https://github.com/a/b", "https://github.com/a/b/issues/3",
            "https://github.com/a/b/pull/abc", "https://github.com/a/b/pull/0", "https://github.com/a/b/blob/main",
            "https://raw.githubusercontent.com/a/b/main"
        ]) {
            expect(ScriptLink.parse(link).isEmpty(), link).toBe(true)
        }
    })
})

describe("ScriptLink.candidates", () => {
    it("finds script.ts or script.js in a folder", async () => {
        const fetcher = fakeFetch({"https://raw.githubusercontent.com/andremichelle/opendaw-commons/main/scripts/apparat/tone/script.js": "x"})
        const location = ScriptLink.parse("https://github.com/andremichelle/opendaw-commons/tree/main/scripts/apparat/tone/").unwrap()
        expect(await ScriptLink.candidates(location, fetcher)).toEqual([commons("main", "scripts/apparat/tone/script.js")])
    })
    it("fails on a folder without a script", async () => {
        const location = ScriptLink.parse("https://github.com/andremichelle/opendaw-commons/tree/main/scripts/apparat/tone").unwrap()
        await expect(ScriptLink.candidates(location, fakeFetch({}))).rejects.toThrow(/No script.ts or script.js/)
    })
    it("lists the scripts a pull request adds or changes, from the fork at its head commit", async () => {
        const api = "https://api.github.com/repos/andremichelle/opendaw-commons/pulls/7"
        const fetcher = fakeFetch({
            [api]: {head: {sha: "abc123", repo: {full_name: "jane/opendaw-commons"}}},
            [`${api}/files?per_page=100`]: [
                {filename: "scripts/apparat/my-synth/script.js", status: "added"},
                {filename: "scripts/apparat/my-synth/meta.json", status: "added"},
                {filename: "scripts/project/old/script.ts", status: "removed"},
                {filename: "scripts/project/acid/script.ts", status: "modified"},
                {filename: "README.md", status: "modified"}
            ]
        })
        const location = ScriptLink.parse("https://github.com/andremichelle/opendaw-commons/pull/7").unwrap()
        expect(await ScriptLink.candidates(location, fetcher)).toEqual([
            {owner: "jane", repo: "opendaw-commons", ref: "abc123", path: "scripts/apparat/my-synth/script.js"},
            {owner: "jane", repo: "opendaw-commons", ref: "abc123", path: "scripts/project/acid/script.ts"}
        ])
    })
    it("fails when the pull request's fork was deleted", async () => {
        const api = "https://api.github.com/repos/a/b/pulls/1"
        const location = ScriptLink.parse("https://github.com/a/b/pull/1").unwrap()
        await expect(ScriptLink.candidates(location, fakeFetch({[api]: {head: {sha: "x", repo: null}}}))).rejects.toThrow(/gone/)
    })
    it("reports GitHub errors such as the rate limit", async () => {
        const location = ScriptLink.parse("https://github.com/a/b/pull/1").unwrap()
        const fetcher = async () => new Response("rate limited", {status: 403})
        await expect(ScriptLink.candidates(location, fetcher)).rejects.toThrow(/403/)
    })
})

describe("ScriptLink.load", () => {
    const raw = (path: string) => `https://raw.githubusercontent.com/andremichelle/opendaw-commons/main/${path}`
    it("loads a commons script with its name, target and language", async () => {
        const fetcher = fakeFetch({
            [raw("scripts/apparat/tone/script.js")]: "// @label Tone\nclass Processor {}\n",
            [raw("scripts/apparat/tone/meta.json")]: {name: "Tone Synth"}
        })
        expect(await ScriptLink.load(commons("main", "scripts/apparat/tone/script.js"), fetcher)).toEqual({
            name: "Tone Synth", target: "apparat", language: "js",
            source: "// @label Tone\nclass Processor {}\n", link: raw("scripts/apparat/tone/script.js")
        })
    })
    it("strips the import preamble of a project script", async () => {
        const fetcher = fakeFetch({[raw("scripts/project/acid/script.ts")]: "import {Api} from \"x\"\nconst openDAW: Api = 0 as never\n// Acid\nrun()\n"})
        const loaded = await ScriptLink.load(commons("main", "scripts/project/acid/script.ts"), fetcher)
        expect(loaded.source).toBe("// Acid\nrun()\n")
        expect(loaded.name).toBe("acid")
        expect(loaded.target).toBe("project")
    })
    it("falls back to the slug when meta.json is missing or broken", async () => {
        const fetcher = fakeFetch({[raw("scripts/spielwerk/arp/script.js")]: "class Processor {}", [raw("scripts/spielwerk/arp/meta.json")]: "{nope"})
        expect((await ScriptLink.load(commons("main", "scripts/spielwerk/arp/script.js"), fetcher)).name).toBe("arp")
    })
    it("loads files outside the commons layout without a target", async () => {
        const file = {owner: "jane", repo: "sketches", ref: "main", path: "synths/fm.js"}
        const fetcher = fakeFetch({"https://raw.githubusercontent.com/jane/sketches/main/synths/fm.js": "class Processor {}"})
        const loaded = await ScriptLink.load(file, fetcher)
        expect(loaded.target).toBeUndefined()
        expect(loaded.name).toBe("fm.js")
    })
    it("refuses other file types and missing files", async () => {
        await expect(ScriptLink.load(commons("main", "README.md"), fakeFetch({}))).rejects.toThrow(/not a .ts or .js/)
        await expect(ScriptLink.load(commons("main", "scripts/apparat/gone/script.js"), fakeFetch({}))).rejects.toThrow(/not found/)
    })
})

describe("CommunityIndex.parseScripts", () => {
    const entry = (overrides: Record<string, unknown> = {}) => ({
        uuid: "2a1fb4f4-36dc-8287-8c45-ab5739790516", slug: "tb-303-sequencer", name: "303 Sequencer", description: "x",
        author: {name: "André Michelle", github: "andremichelle"}, tags: ["acid"], license: "CC0-1.0",
        url: "2a1fb4f4-36dc-8287-8c45-ab5739790516-9cf44fac94ee.js", size: 3417, created: 1, modified: 2,
        source: "https://github.com/andremichelle/opendaw-commons/tree/main/scripts/spielwerk/tb-303-sequencer",
        minApi: 1, target: "spielwerk", language: "js", details: {label: "303 Sequencer"}, ...overrides
    })
    it("keeps valid entries", () => {
        const index = CommunityIndex.parseScripts({version: 1, updatedAt: "now", scripts: [entry()]})
        expect(index.scripts.length).toBe(1)
        expect(index.scripts[0].target).toBe("spielwerk")
    })
    it("skips entries for a newer Studio, unknown targets and broken entries, never the whole index", () => {
        const index = CommunityIndex.parseScripts({
            version: 1, scripts: [
                entry(), entry({minApi: CommunityIndex.ApiLevel + 1}), entry({target: "vst"}), entry({uuid: "nope"}),
                entry({url: "../../etc/passwd"}), {}
            ]
        })
        expect(index.scripts.length).toBe(1)
    })
    it("keeps an optional screenshot file name and skips an entry whose screenshot is a path", () => {
        const screenshot = "2a1fb4f4-36dc-8287-8c45-ab5739790516-0123456789ab.webp"
        const index = CommunityIndex.parseScripts({
            version: 1, scripts: [entry({screenshot}), entry({screenshot: "../../etc/passwd"})]
        })
        expect(index.scripts.length).toBe(1)
        expect(index.scripts[0].screenshot).toBe(screenshot)
        expect(CommunityIndex.parseScripts({version: 1, scripts: [entry()]}).scripts[0].screenshot).toBeUndefined()
    })
    it("rejects an unknown index version", () => {
        expect(() => CommunityIndex.parseScripts({version: 2, scripts: []})).toThrow()
    })
})
