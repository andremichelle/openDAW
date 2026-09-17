import {Option, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {OpfsProtocol} from "@opendaw/lib-fusion"
import {Workers} from "../Workers"
import {ScriptMeta} from "./ScriptMeta"
import {ScriptPaths} from "./ScriptPaths"

export type StockScript = {
    uuid: UUID.String
    name: string
    description: string
    source: string
}

export type ScriptFiles = Pick<OpfsProtocol, "read" | "write" | "delete" | "list">

export class ScriptStorage {
    static #instance: Option<ScriptStorage> = Option.None

    static get(): ScriptStorage {
        if (this.#instance.isEmpty()) {this.#instance = Option.wrap(new ScriptStorage(Workers.Opfs))}
        return this.#instance.unwrap()
    }

    // FNV-1a, identifies a shipped stock version so newer builds replace older copies
    static hash(source: string): string {
        return (source.split("")
            .reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 0x01000193), 0x811c9dc5) >>> 0).toString(16)
    }

    readonly #files: ScriptFiles

    constructor(files: ScriptFiles) {this.#files = files}

    async list(): Promise<ReadonlyArray<ScriptStorage.ListEntry>> {
        const entries = await this.#files.list(ScriptPaths.Folder)
        const folders = entries.filter(entry => entry.kind === "directory" && UUID.validateString(entry.name))
        const list = await Promise.all(folders.map(async ({name}) => {
            const uuid = UUID.parse(name)
            const {status, value: meta} = await Promises.tryCatch(this.loadMeta(uuid))
            return status === "resolved" ? Option.wrap({uuid, meta}) : Option.None
        }))
        return list.filter(option => option.nonEmpty()).map(option => option.unwrap())
    }

    async loadMeta(uuid: UUID.Bytes): Promise<ScriptMeta> {
        const bytes = await this.#files.read(ScriptPaths.scriptMeta(uuid))
        return ScriptMeta.fromJSON(JSON.parse(new TextDecoder().decode(bytes)))
    }

    async loadSource(uuid: UUID.Bytes): Promise<string> {
        return new TextDecoder().decode(await this.#files.read(ScriptPaths.scriptFile(uuid)))
    }

    async exists(uuid: UUID.Bytes): Promise<boolean> {
        return (await Promises.tryCatch(this.#files.read(ScriptPaths.scriptMeta(uuid)))).status === "resolved"
    }

    async save(uuid: UUID.Bytes, meta: ScriptMeta, source: string): Promise<void> {
        await this.#files.write(ScriptPaths.scriptFile(uuid), new TextEncoder().encode(source))
        await this.saveMeta(uuid, meta)
    }

    async saveMeta(uuid: UUID.Bytes, meta: ScriptMeta): Promise<void> {
        await this.#files.write(ScriptPaths.scriptMeta(uuid), new TextEncoder().encode(JSON.stringify(meta)))
    }

    async delete(uuid: UUID.Bytes): Promise<void> {
        const trashed = await this.loadTrashedIds()
        const id = UUID.toString(uuid)
        if (!trashed.includes(id)) {trashed.push(id)}
        await this.#files.write(ScriptPaths.TrashFile, new TextEncoder().encode(JSON.stringify(trashed)))
        await this.#files.delete(ScriptPaths.scriptFolder(uuid))
    }

    async loadTrashedIds(): Promise<Array<UUID.String>> {
        const {status, value} = await Promises.tryCatch(this.#files.read(ScriptPaths.TrashFile))
        return status === "rejected" ? [] : JSON.parse(new TextDecoder().decode(value))
    }

    // Stock scripts ship with the app: a newer build replaces older copies, deleted ones stay deleted
    async syncStock(stock: ReadonlyArray<StockScript>): Promise<void> {
        const trashed = await this.loadTrashedIds()
        for (const {uuid: id, name, description, source} of stock) {
            if (trashed.includes(id)) {continue}
            const uuid = UUID.parse(id)
            const hash = ScriptStorage.hash(source)
            const existing = await Promises.tryCatch(this.loadMeta(uuid))
            if (existing.status === "resolved" && existing.value.stock === hash) {continue}
            const modified = new Date().toISOString()
            const created = existing.status === "resolved" ? existing.value.created : modified
            await this.save(uuid, {name, description, created, modified, stock: hash}, source)
        }
    }
}

export namespace ScriptStorage {
    export type ListEntry = {uuid: UUID.Bytes, meta: ScriptMeta}
}
