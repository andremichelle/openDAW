import {Lazy, Option} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {OpenDAWHeaders} from "./OpenDAWHeaders"
import {WclapIndex, WclapIndexEntry} from "./WclapIndex"

// openDAW-hosted bundles at `<FileRoot>/<uuid>.wclap`, gzip without .gz (the host would send Content-Encoding)
export class OpenWclapAPI {
    static readonly FileRoot = "https://assets.opendaw.studio/wclaps"
    static readonly IndexFile = `${OpenWclapAPI.FileRoot}/index.json`

    @Lazy
    static get(): OpenWclapAPI {return new OpenWclapAPI()}

    // a missing or broken index is an empty catalogue, unlike samples nothing waits for it
    readonly #memoized: () => Promise<WclapIndex> = Promises.memoizeAsync(() =>
        fetch(`${OpenWclapAPI.IndexFile}?v=${Date.now()}`, {...OpenDAWHeaders, cache: "no-cache"})
            .then(response => response.ok ? response.json() : Promise.reject(new Error(`${response.status}`)))
            .then(json => WclapIndex.schema.parse(json))
            .catch(() => WclapIndex.Empty))

    private constructor() {}

    tree(): Promise<WclapIndex> {return this.#memoized()}

    async all(): Promise<ReadonlyArray<WclapIndexEntry>> {return WclapIndex.flatten(await this.#memoized())}

    async find(uuid: string): Promise<Option<WclapIndexEntry>> {
        return Option.wrap((await this.all()).find(entry => entry.uuid === uuid))
    }

    async load(uuid: string): Promise<ArrayBuffer> {
        const response = await fetch(`${OpenWclapAPI.FileRoot}/${uuid}.wclap`, OpenDAWHeaders)
        if (!response.ok) {throw new Error(`WebCLAP bundle ${uuid}: ${response.status}`)}
        return response.arrayBuffer()
    }
}
