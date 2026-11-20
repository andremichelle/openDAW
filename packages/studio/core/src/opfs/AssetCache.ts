import {EmptyProcedure, int, Provider, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {StorageWalk} from "@opendaw/lib-fusion"
import {Workers} from "../Workers"
import {GlobalSampleLoaderManager} from "../samples/GlobalSampleLoaderManager"
import {GlobalSoundfontLoaderManager} from "../soundfont/GlobalSoundfontLoaderManager"
import {SampleStorage} from "../samples/SampleStorage"
import {SoundfontStorage} from "../soundfont/SoundfontStorage"
import {StorageScan} from "./StorageScan"

const isItemFile = (path: string): boolean => path.endsWith("/project.od") || path.endsWith(".odp")

export class AssetCache {
    readonly #options: AssetCache.Options

    constructor(options: AssetCache.Options) {this.#options = options}

    async scan(): Promise<AssetCache.Scan> {
        const {sampleManager, soundfontManager, isCached, report} = this.#options
        const {assets, failures} = await (report ?? AssetCache.scanOnMainThread)()
        const unreadable = failures.filter(isItemFile)
        const results: Array<AssetCache.Asset> = []
        for (const asset of assets) {
            if (asset.kind !== "sample" && asset.kind !== "soundfont") {continue}
            if (!UUID.validateString(asset.id)) {continue}
            const ref: AssetCache.Ref = {kind: asset.kind, id: asset.id as UUID.String}
            const uuid = UUID.parse(asset.id)
            const inUse = asset.kind === "sample" ? sampleManager.isInUse(uuid) : soundfontManager.isInUse(uuid)
            const cached = await isCached(ref)
            const incomplete = failures.some(path => path.startsWith(`${asset.path}/`))
            results.push({
                ...ref, name: asset.name, size: asset.size, storedAt: asset.storedAt, usedBy: asset.usedBy, cached, inUse,
                freeable: cached && !inUse && !incomplete && asset.usedBy.length === 0 && unreadable.length === 0
            })
        }
        const freeable = results.filter(asset => asset.freeable)
        return {assets: results, freeable, freeableSize: freeable.reduce((sum, {size}) => sum + size, 0), unreadable}
    }

    async clear(refs: ReadonlyArray<AssetCache.Ref>): Promise<AssetCache.Cleared> {
        const {freeable} = await this.scan()
        const byKey = new Map(freeable.map(asset => [AssetCache.keyOf(asset), asset]))
        const chosen = refs.flatMap(ref => byKey.get(AssetCache.keyOf(ref)) ?? [])
        const skipped = refs.filter(ref => !byKey.has(AssetCache.keyOf(ref)))
        return this.#remove(chosen, skipped)
    }

    async clearAll(exclude: ReadonlyArray<AssetCache.Ref>): Promise<AssetCache.Cleared> {
        const {freeable} = await this.scan()
        const excluded = new Set(exclude.map(AssetCache.keyOf))
        return this.#remove(freeable.filter(asset => !excluded.has(AssetCache.keyOf(asset))), [])
    }

    async #remove(assets: ReadonlyArray<AssetCache.Asset>, skipped: ReadonlyArray<AssetCache.Ref>): Promise<AssetCache.Cleared> {
        const {sampleManager, soundfontManager} = this.#options
        const removed: Array<AssetCache.Asset> = []
        const notRemoved: Array<AssetCache.Ref> = [...skipped]
        const failed: Array<AssetCache.Failure> = []
        for (const asset of assets) {
            const uuid = UUID.parse(asset.id)
            if (asset.kind === "sample" ? sampleManager.isInUse(uuid) : soundfontManager.isInUse(uuid)) {
                notRemoved.push(asset)
                continue
            }
            const folder = asset.kind === "sample" ? SampleStorage.Folder : SoundfontStorage.Folder
            const path = `${folder}/${asset.id}`
            const result = await Promises.tryCatch(Workers.Opfs.delete(path)
                .then(() => Workers.Opfs.exists(path))
                .then(stays => {if (stays) {throw new Error(`'${path}' could not be removed`)}}))
            if (result.status === "resolved") {
                removed.push(asset)
                if (asset.kind === "sample") {sampleManager.remove(uuid)}
            } else {
                failed.push({ref: asset, error: result.error})
            }
        }
        return {removed, skipped: notRemoved, failed, size: removed.reduce((sum, {size}) => sum + size, 0)}
    }
}

export namespace AssetCache {
    export type Kind = "sample" | "soundfont"
    export type Ref = { readonly kind: Kind, readonly id: UUID.String }
    export type Asset = Ref & {
        readonly name: string
        readonly size: int
        readonly storedAt: number
        readonly usedBy: ReadonlyArray<StorageScan.ItemRef>
        readonly cached: boolean
        readonly inUse: boolean
        readonly freeable: boolean
    }
    export type Scan = {
        readonly assets: ReadonlyArray<Asset>
        readonly freeable: ReadonlyArray<Asset>
        readonly freeableSize: int
        readonly unreadable: ReadonlyArray<string>
    }
    export type Cleared = {
        readonly removed: ReadonlyArray<Asset>
        readonly skipped: ReadonlyArray<Ref>
        readonly failed: ReadonlyArray<Failure>
        readonly size: int
    }
    export type Failure = { readonly ref: Ref, readonly error: unknown }
    export type Options = {
        readonly sampleManager: GlobalSampleLoaderManager
        readonly soundfontManager: GlobalSoundfontLoaderManager
        readonly isCached: (ref: Ref) => boolean | Promise<boolean>
        readonly report?: Provider<Promise<StorageScan.Report>>
    }

    export const keyOf = ({kind, id}: Ref): string => `${kind}:${id}`

    export const scanOnMainThread = async (): Promise<StorageScan.Report> => {
        const root = await navigator.storage.getDirectory()
        const read = async (path: string): Promise<Uint8Array> => {
            const segments = path.split("/")
            let folder = root
            for (const segment of segments.slice(0, -1)) {folder = await folder.getDirectoryHandle(segment)}
            const file = await (await folder.getFileHandle(segments[segments.length - 1])).getFile()
            return new Uint8Array(await file.arrayBuffer())
        }
        return StorageScan.scan(await StorageWalk.walk(root, EmptyProcedure), read, EmptyProcedure)
    }
}
