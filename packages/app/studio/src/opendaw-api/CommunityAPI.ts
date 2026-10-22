import {Lazy} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {ScriptPreamble} from "@opendaw/studio-scripting"
import {HttpStatus, retryTransient} from "./HttpRetry"
import {OpenDAWHeaders} from "./OpenDAWHeaders"
import {CommunityIndex, CommunityScript, CommunityScriptIndex, CommunityScriptTarget} from "./CommunityIndex"

export class CommunityAPI {
    static readonly FileRoot = "https://assets.opendaw.studio/community"
    static readonly ScriptsIndexFile = `${CommunityAPI.FileRoot}/scripts/index.json`

    @Lazy
    static get(): CommunityAPI {return new CommunityAPI()}

    // only a fetched index is kept: a failed fetch (memoizeAsync forgets rejections) is tried again next time
    readonly #scripts: () => Promise<CommunityScriptIndex> = Promises.memoizeAsync(() =>
        retryTransient(() => fetch(`${CommunityAPI.ScriptsIndexFile}?v=${Date.now()}`, {...OpenDAWHeaders, cache: "no-cache"})
            .then(response => response.ok ? response.json() : Promise.reject(new HttpStatus(response.status))), 3)
            .then(json => CommunityIndex.parseScripts(json)))

    private constructor() {}

    // a missing or broken index is an empty catalogue, the editors work without it
    scripts(): Promise<CommunityScriptIndex> {return this.#scripts().catch(() => CommunityIndex.EmptyScripts)}

    async scriptsFor(target: CommunityScriptTarget): Promise<ReadonlyArray<CommunityScript>> {
        return (await this.scripts()).scripts.filter(entry => entry.target === target)
    }

    loadSource(entry: CommunityScript): Promise<string> {
        return retryTransient(() => fetch(`${CommunityAPI.FileRoot}/scripts/${entry.url}`, OpenDAWHeaders)
            .then(response => response.ok ? response.text() : Promise.reject(new HttpStatus(response.status))), 4)
            .then(source => entry.target === "project" ? ScriptPreamble.strip(source) : source)
    }
}
