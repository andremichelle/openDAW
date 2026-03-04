import {isDefined, Optional} from "@opendaw/lib-std"
import {AssetSource} from "./AssetTransport"
import {AssetMeta, S3Config} from "../types"

const ASSET_PREFIX = "opendaw/assets"

export class S3AssetSource implements AssetSource {
    readonly name = "s3"
    readonly #config: S3Config

    constructor(config: S3Config) {
        this.#config = config
    }

    getUrl(assetId: string): string {
        const encodedId = encodeURIComponent(assetId)
        if (isDefined(this.#config.endpoint)) {
            return `${this.#config.endpoint}/${this.#config.bucket}/${ASSET_PREFIX}/${encodedId}`
        }
        return `https://${this.#config.bucket}.s3.${this.#config.region}.amazonaws.com/${ASSET_PREFIX}/${encodedId}`
    }

    async resolve(assetId: string): Promise<Optional<ArrayBuffer>> {
        try {
            const response = await fetch(this.getUrl(assetId))
            if (!response.ok) {return undefined}
            return await response.arrayBuffer()
        } catch {
            return undefined
        }
    }

    async publish(assetId: string, data: ArrayBuffer, _meta: AssetMeta): Promise<void> {
        const url = this.getUrl(assetId)
        const response = await fetch(url, {
            method: "PUT",
            body: data,
            headers: {"Content-Type": "application/octet-stream"},
        })
        if (!response.ok) {
            throw new Error(`S3 upload failed: ${response.status} ${response.statusText}`)
        }
    }
}
