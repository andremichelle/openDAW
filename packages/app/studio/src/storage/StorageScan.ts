import {ByteArrayInput, int, isDefined, Nullable, Option, Procedure, tryCatch, unitValue, UUID} from "@opendaw/lib-std"
import {Box, BoxGraph} from "@opendaw/lib-box"
import {StorageWalk} from "@opendaw/lib-fusion"
import {AudioFileBox, BoxIO, SoundfontFileBox, WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {PresetHeader, ProjectSkeleton} from "@opendaw/studio-adapters"

export namespace StorageScan {
    export type AssetKind = "sample" | "soundfont" | "wclap"
    export type ItemKind = "project" | "template" | "preset" | "script" | "model" | "nam-pack"
    export type AssetRef = { kind: AssetKind, id: string }
    export type ItemRef = { kind: ItemKind, id: string }
    export type Asset = AssetRef & {
        name: string, size: int, path: string, origin: Nullable<string>, clapIds: ReadonlyArray<string>,
        usedBy: ReadonlyArray<ItemRef>
    }
    export type Item = ItemRef & {
        name: string, size: int, path: string, uses: ReadonlyArray<AssetRef>, notStored: ReadonlyArray<AssetRef>
    }
    export type Report = {
        total: int, bookkeeping: int, assets: ReadonlyArray<Asset>, items: ReadonlyArray<Item>,
        other: ReadonlyArray<StorageWalk.File>, failures: ReadonlyArray<string>
    }
    export type Reader = (path: string) => Promise<Uint8Array>

    const WclapScheme = "opfs:"
    const Bookkeeping = new Set([
        "projects/v1/trash.json", "templates/v1/trash.json", "samples/v2/trash.json", "soundfont/trash.json",
        "scripts/v1/trash.json", "wclap/tombstones.json", "presets/user/index.json", "presets/user/trash.json"
    ])

    type Rule = { prefix: string, depth: int, kind: AssetKind | ItemKind }
    const Rules: ReadonlyArray<Rule> = [
        {prefix: "projects/v1/", depth: 1, kind: "project"},
        {prefix: "templates/v1/", depth: 1, kind: "template"},
        {prefix: "samples/v2/", depth: 1, kind: "sample"},
        {prefix: "soundfont/", depth: 1, kind: "soundfont"},
        {prefix: "wclap/", depth: 1, kind: "wclap"},
        {prefix: "scripts/v1/", depth: 1, kind: "script"},
        {prefix: "inference/models/", depth: 2, kind: "model"},
        {prefix: "tone3000/", depth: 1, kind: "nam-pack"}
    ]
    const PresetFolder = "presets/user/"

    type Entry = { kind: AssetKind | ItemKind, id: string, path: string, size: int }

    const isAssetKind = (kind: AssetKind | ItemKind): kind is AssetKind =>
        kind === "sample" || kind === "soundfont" || kind === "wclap"

    const classify = (files: ReadonlyArray<StorageWalk.File>) => {
        const entries = new Map<string, Entry>()
        const other: Array<StorageWalk.File> = []
        const bookkeeping = StorageWalk.totalSize(files.filter(({path}) => Bookkeeping.has(path)))
        for (const file of files) {
            if (Bookkeeping.has(file.path)) {continue}
            const optEntry = entryOf(file.path)
            if (optEntry.isEmpty()) {
                other.push(file)
                continue
            }
            const entry = optEntry.unwrap()
            const key = `${entry.kind}:${entry.id}`
            const existing = entries.get(key)
            if (isDefined(existing)) {
                existing.size += file.size
            } else {
                entries.set(key, {...entry, size: file.size})
            }
        }
        return {entries: Array.from(entries.values()), other, bookkeeping}
    }

    const entryOf = (path: string): Option<Omit<Entry, "size">> => {
        if (path.startsWith(PresetFolder) && path.endsWith(".odp") && path.indexOf("/", PresetFolder.length) === -1) {
            return Option.wrap({kind: "preset", id: path.substring(PresetFolder.length, path.length - 4), path})
        }
        for (const {prefix, depth, kind} of Rules) {
            if (!path.startsWith(prefix)) {continue}
            const segments = path.substring(prefix.length).split("/")
            if (segments.length <= depth) {return Option.None}
            const id = segments.slice(0, depth).join("/")
            return Option.wrap({kind, id, path: `${prefix}${id}`})
        }
        return Option.None
    }

    const readJson = async (read: Reader, path: string): Promise<Option<Record<string, unknown>>> => {
        const bytes = await read(path).then(Option.wrap, () => Option.None)
        if (bytes.isEmpty()) {return Option.None}
        const parsed = tryCatch(() => JSON.parse(new TextDecoder().decode(bytes.unwrap())) as unknown)
        return parsed.status === "success" && typeof parsed.value === "object" && parsed.value !== null
            ? Option.wrap(parsed.value as Record<string, unknown>) : Option.None
    }

    const stringOf = (record: Option<Record<string, unknown>>, key: string): Option<string> =>
        record.flatMap(value => typeof value[key] === "string" ? Option.wrap(value[key] as string) : Option.None)

    const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

    const decodeProject = (bytes: Uint8Array): BoxGraph => ProjectSkeleton.decode(exactBuffer(bytes)).boxGraph

    const decodePreset = (bytes: Uint8Array): BoxGraph => {
        const buffer = exactBuffer(bytes)
        const header = new ByteArrayInput(buffer)
        if (header.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {throw new Error("Not a preset")}
        if (header.readInt() !== PresetHeader.FORMAT_VERSION) {throw new Error("Unknown preset version")}
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.fromArrayBuffer(buffer.slice(8), false)
        return graph
    }

    export type References = { refs: ReadonlyArray<AssetRef>, clapIds: ReadonlyMap<string, ReadonlyArray<string>> }

    export const referencesOf = (graph: BoxGraph): References => {
        const refs = new Map<string, AssetRef>()
        const clapIds = new Map<string, Array<string>>()
        for (const box of graph.boxes() as Iterable<Box>) {
            if (box instanceof AudioFileBox) {
                const id = UUID.toString(box.address.uuid)
                refs.set(`sample:${id}`, {kind: "sample", id})
            } else if (box instanceof SoundfontFileBox) {
                const id = UUID.toString(box.address.uuid)
                refs.set(`soundfont:${id}`, {kind: "soundfont", id})
            } else if (box instanceof WclapDeviceBox || box instanceof WclapInstrumentBox) {
                const url = box.url.getValue()
                if (!url.startsWith(WclapScheme)) {continue}
                const id = url.substring(WclapScheme.length)
                refs.set(`wclap:${id}`, {kind: "wclap", id})
                const clapId = box.clapId.getValue()
                const list = clapIds.get(id) ?? []
                if (clapId.length > 0 && !list.includes(clapId)) {list.push(clapId)}
                clapIds.set(id, list)
            }
        }
        return {refs: Array.from(refs.values()), clapIds}
    }

    export const scan = async (walk: StorageWalk.Result, read: Reader,
                               progress: Procedure<unitValue>): Promise<Report> => {
        const {entries, other, bookkeeping} = classify(walk.files)
        const failures: Array<string> = [...walk.failures]
        const presetIndex = await read(`${PresetFolder}index.json`)
            .then(bytes => tryCatch(() => JSON.parse(new TextDecoder().decode(bytes)) as unknown), () => null)
        const presetName = new Map<string, string>()
        if (isDefined(presetIndex) && presetIndex.status === "success" && Array.isArray(presetIndex.value)) {
            for (const entry of presetIndex.value as ReadonlyArray<Record<string, unknown>>) {
                if (typeof entry.uuid === "string" && typeof entry.name === "string") {presetName.set(entry.uuid, entry.name)}
            }
        }
        const decodable = entries.filter(({kind}) => kind === "project" || kind === "template" || kind === "preset")
        const usedBy = new Map<string, Array<ItemRef>>()
        const clapIds = new Map<string, Array<string>>()
        const references = new Map<string, ReadonlyArray<AssetRef>>()
        for (const [index, entry] of decodable.entries()) {
            const file = entry.kind === "preset" ? entry.path : `${entry.path}/project.od`
            const bytes = await read(file).then(Option.wrap, () => Option.None)
            const decoded = bytes.isEmpty() ? null : tryCatch(() =>
                entry.kind === "preset" ? decodePreset(bytes.unwrap()) : decodeProject(bytes.unwrap()))
            if (!isDefined(decoded) || decoded.status === "failure") {
                failures.push(file)
            } else {
                const {refs, clapIds: ids} = referencesOf(decoded.value)
                references.set(`${entry.kind}:${entry.id}`, refs)
                for (const ref of refs) {
                    const key = `${ref.kind}:${ref.id}`
                    const list = usedBy.get(key) ?? []
                    list.push({kind: entry.kind as ItemKind, id: entry.id})
                    usedBy.set(key, list)
                }
                ids.forEach((values, id) => {
                    const list = clapIds.get(id) ?? []
                    values.forEach(value => {if (!list.includes(value)) {list.push(value)}})
                    clapIds.set(id, list)
                })
            }
            progress((index + 1) / decodable.length)
        }
        const stored = new Set(entries.filter(({kind}) => isAssetKind(kind)).map(({kind, id}) => `${kind}:${id}`))
        const assets: Array<Asset> = []
        const items: Array<Item> = []
        for (const entry of entries) {
            const key = `${entry.kind}:${entry.id}`
            if (isAssetKind(entry.kind)) {
                const meta = entry.kind === "wclap" ? Option.None : await readJson(read, `${entry.path}/meta.json`)
                const ids = clapIds.get(entry.id) ?? []
                assets.push({
                    kind: entry.kind, id: entry.id, path: entry.path, size: entry.size,
                    name: stringOf(meta, "name").unwrapOrElse(ids.at(0) ?? entry.id),
                    origin: stringOf(meta, "origin").unwrapOrNull(), clapIds: ids, usedBy: usedBy.get(key) ?? []
                })
            } else {
                const uses = references.get(key) ?? []
                items.push({
                    kind: entry.kind, id: entry.id, path: entry.path, size: entry.size,
                    name: await itemName(read, entry, presetName),
                    uses: uses.filter(ref => stored.has(`${ref.kind}:${ref.id}`)),
                    notStored: uses.filter(ref => !stored.has(`${ref.kind}:${ref.id}`))
                })
            }
        }
        progress(1.0)
        return {total: StorageWalk.totalSize(walk.files), bookkeeping, assets, items, other, failures}
    }

    const itemName = async (read: Reader, {kind, id, path}: Entry, presetName: ReadonlyMap<string, string>): Promise<string> => {
        switch (kind) {
            case "preset":
                return presetName.get(id) ?? id
            case "model":
                return id.replace("/", " ")
            case "nam-pack":
                return stringOf(await readJson(read, `${path}/pack.json`), "title").unwrapOrElse(id)
            default:
                return stringOf(await readJson(read, `${path}/meta.json`), "name").unwrapOrElse(id)
        }
    }
}
