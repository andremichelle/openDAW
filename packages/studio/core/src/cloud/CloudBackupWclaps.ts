import {Errors, isDefined, panic, Procedure, Progress, tryCatch} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"
import {WclapStorage} from "../wclap/WclapStorage"

// a bundle lives when its storage time is later than its deletion time
export class CloudBackupWclaps {
    static readonly RemotePath = "wclaps"
    static readonly RemoteCatalogPath = `${this.RemotePath}/index.json`
    static readonly RemoteTombstonesPath = `${this.RemotePath}/tombstones.json`

    static pathFor(id: string): string {return `${this.RemotePath}/${id}.tar.gz`}

    static async start(cloudHandler: CloudHandler, progress: Progress.Handler, log: Procedure<string>) {
        log("Collecting WebCLAP bundles...")
        const ids = await WclapStorage.list()
        const local = new Map(await Promise.all(ids.map(async id => [id, await WclapStorage.storedAt(id)] as const)))
        const [catalog, remoteTombstones, localTombstones] = await Promise.all([
            CloudBackupWclaps.#downloadText(cloudHandler, CloudBackupWclaps.RemoteCatalogPath).then(parseCatalog),
            CloudBackupWclaps.#downloadText(cloudHandler, CloudBackupWclaps.RemoteTombstonesPath).then(WclapStorage.parseTombstones),
            WclapStorage.tombstones()
        ])
        const tombstones = WclapStorage.mergeTombstones(localTombstones, remoteTombstones)
        if (!sameTombstones(tombstones, localTombstones)) {await WclapStorage.writeTombstones(tombstones)}
        if (!sameTombstones(tombstones, remoteTombstones)) {
            log("Syncing WebCLAP deletions...")
            await cloudHandler.upload(CloudBackupWclaps.RemoteTombstonesPath, encodeJson(tombstones))
        }
        return new CloudBackupWclaps(cloudHandler, local, catalog, tombstones, log).#start(progress)
    }

    static #downloadText(cloudHandler: CloudHandler, path: string): Promise<string> {
        return cloudHandler.download(path)
            .then(bytes => new TextDecoder().decode(bytes))
            .catch(reason => reason instanceof Errors.FileNotFound ? "" : panic(reason))
    }

    readonly #cloudHandler: CloudHandler
    readonly #local: Map<string, number>
    readonly #catalog: Map<string, number>
    readonly #tombstones: WclapStorage.Tombstones
    readonly #log: Procedure<string>

    private constructor(cloudHandler: CloudHandler, local: Map<string, number>, catalog: Map<string, number>,
                        tombstones: WclapStorage.Tombstones, log: Procedure<string>) {
        this.#cloudHandler = cloudHandler
        this.#local = local
        this.#catalog = catalog
        this.#tombstones = tombstones
        this.#log = log
    }

    #isDeleted(id: string, storedAt: number): boolean {
        const deletedAt = this.#tombstones[id]
        return isDefined(deletedAt) && deletedAt >= storedAt
    }

    async #start(progress: Progress.Handler) {
        const [uploadProgress, downloadProgress] = Progress.split(progress, 2)
        const catalogBefore = JSON.stringify(Object.fromEntries(this.#catalog))
        await this.#purge()
        await this.#upload(uploadProgress)
        await this.#download(downloadProgress)
        if (JSON.stringify(Object.fromEntries(this.#catalog)) !== catalogBefore) {
            await this.#cloudHandler.upload(CloudBackupWclaps.RemoteCatalogPath, encodeJson(Object.fromEntries(this.#catalog)))
        }
    }

    async #purge() {
        for (const [id, storedAt] of Array.from(this.#local)) {
            if (!this.#isDeleted(id, storedAt)) {continue}
            this.#log(`Removing deleted WebCLAP bundle ${id.substring(0, 8)}`)
            await WclapStorage.discard(id)
            this.#local.delete(id)
        }
        for (const [id, storedAt] of Array.from(this.#catalog)) {
            if (!this.#isDeleted(id, storedAt)) {continue}
            await Promises.tryCatch(this.#cloudHandler.delete(CloudBackupWclaps.pathFor(id)))
            this.#catalog.delete(id)
        }
    }

    async #upload(progress: Progress.Handler) {
        for (const [id, storedAt] of this.#local) {
            const listed = this.#catalog.get(id)
            if (isDefined(listed) && listed < storedAt) {this.#catalog.set(id, storedAt)}
        }
        const unsynced = Array.from(this.#local.keys()).filter(id => !this.#catalog.has(id))
        if (unsynced.length === 0) {
            progress(1.0)
            return
        }
        await Promises.sequentialAll(unsynced.map((id, index, {length}) => async () => {
            progress((index + 1) / length)
            this.#log(`Uploading WebCLAP bundle ${id.substring(0, 8)}`)
            const archive = await WclapStorage.loadId(id)
            await Promises.approvedRetry(() => this.#cloudHandler.upload(CloudBackupWclaps.pathFor(id), archive), error => ({
                headline: "Upload failed",
                message: `Failed to upload a WebCLAP bundle. '${error}'`,
                approveText: "Retry",
                cancelText: "Cancel"
            }))
            this.#catalog.set(id, this.#local.get(id) ?? 0)
        }))
        progress(1.0)
    }

    async #download(progress: Progress.Handler) {
        const missing = Array.from(this.#catalog.keys()).filter(id => !this.#local.has(id))
        if (missing.length === 0) {
            progress(1.0)
            return
        }
        await Promises.sequentialAll(missing.map((id, index, {length}) => async () => {
            progress((index + 1) / length)
            this.#log(`Downloading WebCLAP bundle ${id.substring(0, 8)}`)
            const archive = await Promises.guardedRetry(() => this.#cloudHandler.download(CloudBackupWclaps.pathFor(id)), network.defaultRetry)
            if (await WclapStorage.urlFor(archive) !== WclapStorage.urlOf(id)) {
                this.#log(`Skipped WebCLAP bundle ${id.substring(0, 8)}, its content does not match its id`)
                return
            }
            await WclapStorage.save(id, archive, this.#catalog.get(id) ?? 0)
        }))
        progress(1.0)
    }
}

const encodeJson = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value, null, 2)).buffer as ArrayBuffer

const sameTombstones = (a: WclapStorage.Tombstones, b: WclapStorage.Tombstones): boolean =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, time]) => b[id] === time)

// id -> storage time, a plain id array (the format before deletions existed) counts as stored at 0
const parseCatalog = (text: string): Map<string, number> => {
    const parsed = tryCatch(() => JSON.parse(text) as unknown)
    if (parsed.status === "failure" || typeof parsed.value !== "object" || parsed.value === null) {return new Map()}
    if (Array.isArray(parsed.value)) {
        return new Map(parsed.value.filter((id): id is string => typeof id === "string").map(id => [id, 0]))
    }
    return new Map(Object.entries(parsed.value)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number"))
}
