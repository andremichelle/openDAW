import {Optional} from "@opendaw/lib-std"
import {AssetSource} from "./AssetTransport"
import {AssetMeta} from "../types"

export class OpfsAssetSource implements AssetSource {
    readonly name = "opfs"
    readonly #folder: string

    constructor(folder: string = "collab-assets") {
        this.#folder = folder
    }

    async resolve(assetId: string): Promise<Optional<ArrayBuffer>> {
        try {
            const root = await navigator.storage.getDirectory()
            const dir = await root.getDirectoryHandle(this.#folder)
            const file = await dir.getFileHandle(assetId)
            const blob = await file.getFile()
            return await blob.arrayBuffer()
        } catch {
            return undefined
        }
    }

    async publish(assetId: string, data: ArrayBuffer, _meta: AssetMeta): Promise<void> {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle(this.#folder, {create: true})
        const file = await dir.getFileHandle(assetId, {create: true})
        const writable = await file.createWritable()
        try {
            await writable.write(data)
        } finally {
            await writable.close()
        }
    }
}
