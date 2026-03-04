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

    async resolve(assetId: string): Promise<Optional<ArrayBuffer>> {
        for (const source of this.#sources) {
            const result = await source.resolve(assetId)
            if (isDefined(result)) {
                console.debug(`Asset '${assetId}' resolved from ${source.name}`)
                return result
            }
        }
        console.warn(`Asset '${assetId}' not found in any source`)
        return undefined
    }

    async publish(assetId: string, data: ArrayBuffer, meta: AssetMeta): Promise<void> {
        await Promise.all(this.#sources.map(source => source.publish(assetId, data, meta)))
    }
}
