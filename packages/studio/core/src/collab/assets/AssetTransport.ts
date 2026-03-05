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
        const failures = results.filter(result => result.status === "rejected")
        for (const result of failures) {
            console.warn("[AssetTransportChain] publish partial failure:", (result as PromiseRejectedResult).reason)
        }
        if (failures.length === results.length) {
            throw new Error(`[AssetTransportChain] publish failed on all ${results.length} source(s)`)
        }
    }
}
