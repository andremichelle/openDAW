import {isAbsent, isDefined, Option, Optional, panic, tryCatch} from "@opendaw/lib-std"
import {ScriptPreamble} from "@opendaw/studio-scripting"
import {CommunityScriptTarget, CommunityScriptTargets} from "./CommunityIndex"

export type ScriptLinkFile = {
    readonly owner: string
    readonly repo: string
    readonly ref: string
    readonly path: string
}

export type ScriptLinkSource = {
    readonly name: string
    readonly target: Optional<CommunityScriptTarget>
    readonly language: "ts" | "js"
    readonly source: string
    readonly link: string
}

export type ScriptLinkLocation =
    | { readonly kind: "file", readonly file: ScriptLinkFile }
    | { readonly kind: "folder", readonly file: ScriptLinkFile }
    | { readonly kind: "pull", readonly owner: string, readonly repo: string, readonly number: number }

type Fetcher = (url: string) => Promise<Response>

type PullInfo = { head: { sha: string, repo: Optional<{ full_name: string }> } }
type PullFile = { filename: string, status: string }

const ITEM = /(^|\/)scripts\/(project|werkstatt|apparat|spielwerk)\/([a-z0-9-]+)(\/script\.(ts|js))?$/
const SCRIPT_FILE = /^scripts\/(project|werkstatt|apparat|spielwerk)\/[a-z0-9-]+\/script\.(ts|js)$/

// a branch name may hold slashes, inside the commons layout the path starts at scripts/<target>/
const splitRefAndPath = (segments: ReadonlyArray<string>): Optional<{ ref: string, path: string }> => {
    const start = segments.findIndex((segment, index) =>
        segment === "scripts" && CommunityScriptTargets.some(target => target === segments[index + 1]))
    if (start > 0) {return {ref: segments.slice(0, start).join("/"), path: segments.slice(start).join("/")}}
    if (segments.length < 2) {return undefined}
    return {ref: segments[0], path: segments.slice(1).join("/")}
}

const rawUrl = ({owner, repo, ref, path}: ScriptLinkFile): string =>
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`

const fetchText = async (fetcher: Fetcher, url: string): Promise<Optional<string>> => {
    const response = await fetcher(url)
    if (response.status === 404) {return undefined}
    if (!response.ok) {return panic(`${url} answered ${response.status}`)}
    return response.text()
}

const fetchJson = async <T>(fetcher: Fetcher, url: string): Promise<T> => {
    const response = await fetcher(url)
    if (!response.ok) {return panic(`GitHub answered ${response.status} for ${url}`)}
    return await response.json() as T
}

const nameFromMeta = async (fetcher: Fetcher, file: ScriptLinkFile): Promise<Optional<string>> => {
    const folder = file.path.substring(0, file.path.lastIndexOf("/"))
    const text = await fetchText(fetcher, rawUrl({...file, path: `${folder}/meta.json`})).catch(() => undefined)
    if (isAbsent(text)) {return undefined}
    const parsed = tryCatch(() => JSON.parse(text) as unknown)
    if (parsed.status === "failure") {return undefined}
    const meta = parsed.value
    const name: unknown = typeof meta === "object" && isDefined(meta) ? Reflect.get(meta, "name") : undefined
    return typeof name === "string" && name.length > 0 ? name : undefined
}

export namespace ScriptLink {
    export const parse = (link: string): Option<ScriptLinkLocation> => {
        const parsed = tryCatch(() => new URL(link.trim()))
        if (parsed.status === "failure" || parsed.value.protocol !== "https:") {return Option.None}
        const url = parsed.value
        const segments = url.pathname.split("/").filter(segment => segment.length > 0).map(decodeURIComponent)
        if (url.hostname === "raw.githubusercontent.com") {
            const [owner, repo, ...rest] = segments
            const split = splitRefAndPath(rest[0] === "refs" && rest[1] === "heads" ? rest.slice(2) : rest)
            if (isAbsent(owner) || isAbsent(repo) || isAbsent(split)) {return Option.None}
            return Option.wrap({kind: "file", file: {owner, repo, ...split}})
        }
        if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {return Option.None}
        const [owner, repo, kind, ...rest] = segments
        if (isAbsent(owner) || isAbsent(repo)) {return Option.None}
        if (kind === "pull") {
            const number = Number(rest[0])
            return Number.isInteger(number) && number > 0 ? Option.wrap({kind: "pull", owner, repo, number}) : Option.None
        }
        if (kind !== "blob" && kind !== "tree") {return Option.None}
        const split = splitRefAndPath(rest)
        if (isAbsent(split)) {return Option.None}
        return Option.wrap({kind: kind === "blob" ? "file" : "folder", file: {owner, repo, ...split}})
    }

    // a pull request may change several scripts, the caller lets the user pick one
    export const candidates = async (location: ScriptLinkLocation, fetcher: Fetcher = fetch): Promise<ReadonlyArray<ScriptLinkFile>> => {
        switch (location.kind) {
            case "file":
                return [location.file]
            case "folder": {
                const folder = location.file.path.replace(/\/$/, "")
                for (const name of ["script.ts", "script.js"]) {
                    const file = {...location.file, path: `${folder}/${name}`}
                    const response = await fetcher(rawUrl(file))
                    if (response.ok) {return [file]}
                }
                return panic(`No script.ts or script.js in ${folder}`)
            }
            case "pull": {
                const api = `https://api.github.com/repos/${location.owner}/${location.repo}/pulls/${location.number}`
                const pull = await fetchJson<PullInfo>(fetcher, api)
                const head = pull.head.repo
                if (isAbsent(head)) {return panic("The pull request's repository is gone")}
                const [owner, repo] = head.full_name.split("/")
                const files = await fetchJson<ReadonlyArray<PullFile>>(fetcher, `${api}/files?per_page=100`)
                return files
                    .filter(({filename, status}) => status !== "removed" && SCRIPT_FILE.test(filename))
                    .map(({filename}) => ({owner, repo, ref: pull.head.sha, path: filename}))
            }
        }
    }

    export const load = async (file: ScriptLinkFile, fetcher: Fetcher = fetch): Promise<ScriptLinkSource> => {
        const extension = file.path.substring(file.path.lastIndexOf(".") + 1)
        if (extension !== "ts" && extension !== "js") {return panic(`${file.path} is not a .ts or .js file`)}
        const text = await fetchText(fetcher, rawUrl(file))
        if (isAbsent(text)) {return panic(`${file.path} was not found`)}
        const match = ITEM.exec(file.path)
        const target = isDefined(match) ? CommunityScriptTargets.find(entry => entry === match[2]) : undefined
        const fallbackName = isDefined(match) ? match[3] : file.path.substring(file.path.lastIndexOf("/") + 1)
        const name = isDefined(match) ? (await nameFromMeta(fetcher, file)) ?? fallbackName : fallbackName
        return {
            name, target, language: extension,
            source: target === "project" || isAbsent(target) ? ScriptPreamble.strip(text) : text,
            link: rawUrl(file)
        }
    }
}
