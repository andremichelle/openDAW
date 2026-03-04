import {isDefined, Optional} from "@opendaw/lib-std"
import {AssetMeta} from "../types"

export interface AssetSource {
    readonly name: string
    resolve(assetId: string): Promise<Optional<ArrayBuffer>>
    publish(assetId: string, data: ArrayBuffer, meta: AssetMeta): Promise<void>
}

export class AssetTransportChain {
    readonly #sources: ReadonlyArray<AssetSource>

    constructor(sources: ReadonlyArray<AssetSource>) {
        this.#sources = sources
    }

    get sourceNames(): ReadonlyArray<string> {
        return this.#sources.map(source => source.name)
    }

    async resolve(assetId: string): Promise<Optional<ArrayBuffer>> {
        for (const source of this.#sources) {
            try {
                const result = await source.resolve(assetId)
                if (isDefined(result)) {
                    console.debug(`Asset '${assetId}' resolved from ${source.name}`)
                    return result
                }
            } catch (error) {
                console.warn(`Asset source '${source.name}' threw during resolve:`, error)
            }
        }
        console.warn(`Asset '${assetId}' not found in any source`)
        return undefined
    }

    async publish(assetId: string, data: ArrayBuffer, meta: AssetMeta): Promise<void> {
        const results = await Promise.allSettled(this.#sources.map(source => source.publish(assetId, data, meta)))
        for (const result of results) {
            if (result.status === "rejected") {
                console.warn("[AssetTransportChain] publish partial failure:", result.reason)
            }
        }
    }
}
