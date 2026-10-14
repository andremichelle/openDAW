import {Lazy, Option, Progress} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {OpenDAWHeaders} from "./OpenDAWHeaders"
import {WclapIndex, WclapIndexEntry} from "./WclapIndex"

// openDAW-hosted bundles at `<FileRoot>/<uuid>.wclap`, gzip without .gz (the host would send Content-Encoding)
export class OpenWclapAPI {
    static readonly FileRoot = "https://assets.opendaw.studio/wclaps"
    static readonly IndexFile = `${OpenWclapAPI.FileRoot}/index.json`

    @Lazy
    static get(): OpenWclapAPI {return new OpenWclapAPI()}

    // only a fetched index is kept: a failed fetch (memoizeAsync forgets rejections) is tried again next time
    readonly #memoized: () => Promise<WclapIndex> = Promises.memoizeAsync(() =>
        retryTransient(() => fetch(`${OpenWclapAPI.IndexFile}?v=${Date.now()}`, {...OpenDAWHeaders, cache: "no-cache"})
            .then(response => response.ok ? response.json() : Promise.reject(new HttpStatus(response.status))), 3)
            .then(json => WclapIndex.schema.parse(json)))

    private constructor() {}

    // a missing or broken index is an empty catalogue for now, unlike samples nothing waits for it
    tree(): Promise<WclapIndex> {return this.#memoized().catch(() => WclapIndex.Empty)}

    async all(): Promise<ReadonlyArray<WclapIndexEntry>> {return WclapIndex.flatten(await this.tree())}

    async find(uuid: string): Promise<Option<WclapIndexEntry>> {
        return Option.wrap((await this.all()).find(entry => entry.uuid === uuid))
    }

    // the body is read inside the attempt, a stream the host breaks halfway (HTTP/2 protocol error) is retried too
    load(uuid: string, progress: Progress.Handler = Progress.Empty): Promise<ArrayBuffer> {
        return retryTransient(() => fetch(`${OpenWclapAPI.FileRoot}/${uuid}.wclap`, OpenDAWHeaders)
            .then(response => response.ok
                ? network.progress(progress)(response).arrayBuffer()
                : Promise.reject(new HttpStatus(response.status))), 4)
    }
}

class HttpStatus extends Error {
    constructor(readonly status: number) {super(`HTTP ${status}`)}
}

// network failures and 5xx are worth another attempt, a 4xx answer will not change
const retryTransient = <T>(factory: () => Promise<T>, attempts: number): Promise<T> =>
    Promises.guardedRetry(factory, (error, count) =>
        count < attempts && !(error instanceof HttpStatus && error.status < 500))
