import {Lazy, Progress} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {ScriptPreamble} from "@opendaw/studio-scripting"
import {HttpStatus, retryTransient} from "./HttpRetry"
import {OpenDAWHeaders} from "./OpenDAWHeaders"
import {CommunityIndex, CommunityScript, CommunityScriptIndex, CommunityScriptTarget} from "./CommunityIndex"
import {WclapIndex} from "./WclapIndex"

export class CommunityAPI {
    static readonly FileRoot = "https://assets.opendaw.studio/community"
    static readonly ScriptsIndexFile = `${CommunityAPI.FileRoot}/scripts/index.json`
    static readonly WclapsIndexFile = `${CommunityAPI.FileRoot}/wclaps/index.json`

    @Lazy
    static get(): CommunityAPI {return new CommunityAPI()}

    // only a fetched index is kept: a failed fetch (memoizeAsync forgets rejections) is tried again next time
    readonly #scripts: () => Promise<CommunityScriptIndex> = Promises.memoizeAsync(() =>
        retryTransient(() => fetch(`${CommunityAPI.ScriptsIndexFile}?v=${Date.now()}`, {...OpenDAWHeaders, cache: "no-cache"})
            .then(response => response.ok ? response.json() : Promise.reject(new HttpStatus(response.status))), 3)
            .then(json => CommunityIndex.parseScripts(json)))

    readonly #wclaps: () => Promise<WclapIndex> = Promises.memoizeAsync(() =>
        retryTransient(() => fetch(`${CommunityAPI.WclapsIndexFile}?v=${Date.now()}`, {...OpenDAWHeaders, cache: "no-cache"})
            .then(response => response.ok ? response.json() : Promise.reject(new HttpStatus(response.status))), 3)
            .then(json => WclapIndex.schema.parse(json)))

    private constructor() {}

    // the community WebCLAPs, built from source by the opendaw-commons CI, same format and naming as the cloud ones
    wclaps(): Promise<WclapIndex> {return this.#wclaps().catch(() => WclapIndex.Empty)}

    loadWclap(uuid: string, progress: Progress.Handler = Progress.Empty): Promise<ArrayBuffer> {
        return retryTransient(() => fetch(`${CommunityAPI.FileRoot}/wclaps/${uuid}.wclap`, OpenDAWHeaders)
            .then(response => response.ok
                ? network.progress(progress)(response).arrayBuffer()
                : Promise.reject(new HttpStatus(response.status))), 4)
    }

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
