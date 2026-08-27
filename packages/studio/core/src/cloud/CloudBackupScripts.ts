import {Arrays, Errors, isAbsent, isDefined, Maybe, panic, Procedure, Progress, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"
import {ScriptMeta, ScriptPaths, ScriptStorage} from "../scripts"

type Scripts = Record<UUID.String, ScriptMeta>
type ScriptDomains = Record<"local" | "cloud", Scripts>
type Entry = [UUID.String, ScriptMeta]

export class CloudBackupScripts {
    static readonly RemotePath = "scripts"
    static readonly RemoteCatalogPath = `${this.RemotePath}/index.json`

    static folderFor(uuid: UUID.String): string {return `${this.RemotePath}/${uuid}`}

    static async start(cloudHandler: CloudHandler,
                       progress: Progress.Handler,
                       log: Procedure<string>) {
        log("Collecting all script domains...")
        const [local, cloud] = await Promise.all([
            ScriptStorage.get().list()
                .then(list => list.reduce((record: Scripts, {uuid, meta}) => {
                    record[UUID.toString(uuid)] = meta
                    return record
                }, {})),
            cloudHandler.download(CloudBackupScripts.RemoteCatalogPath)
                .then(json => JSON.parse(new TextDecoder().decode(json)))
                .catch(reason => reason instanceof Errors.FileNotFound ? {} : panic(reason))
        ])
        return new CloudBackupScripts(cloudHandler, {local, cloud}, log).#start(progress)
    }

    readonly #cloudHandler: CloudHandler
    readonly #scriptDomains: ScriptDomains
    readonly #log: Procedure<string>

    private constructor(cloudHandler: CloudHandler, scriptDomains: ScriptDomains, log: Procedure<string>) {
        this.#cloudHandler = cloudHandler
        this.#scriptDomains = scriptDomains
        this.#log = log
    }

    async #start(progress: Progress.Handler): Promise<void> {
        const trashed = await ScriptStorage.get().loadTrashedIds()
        const [uploadProgress, trashProgress, downloadProgress] = Progress.splitWithWeights(progress, [0.45, 0.10, 0.45])
        await this.#upload(uploadProgress)
        await this.#trash(trashed, trashProgress)
        await this.#download(trashed, downloadProgress)
    }

    async #upload(progress: Progress.Handler): Promise<void> {
        const {local, cloud} = this.#scriptDomains
        const isUnsynced = (localScript: ScriptMeta, cloudScript: Maybe<ScriptMeta>) =>
            isAbsent(cloudScript) || CloudBackupScripts.#time(cloudScript) < CloudBackupScripts.#time(localScript)
        const unsynced: ReadonlyArray<Entry> = CloudBackupScripts.#entries(local)
            .filter(([uuid, meta]) => isUnsynced(meta, cloud[uuid]))
        if (unsynced.length === 0) {
            this.#log("No unsynced scripts found.")
            progress(1.0)
            return
        }
        const uploaded: ReadonlyArray<Entry> = await Promises.sequentialAll(unsynced
            .map(([uuid, meta], index, {length}) => async () => {
                progress((index + 1) / length)
                this.#log(`Uploading script '${meta.name}'`)
                const folder = CloudBackupScripts.folderFor(uuid)
                const source = await ScriptStorage.get().loadSource(UUID.parse(uuid))
                await Promises.approvedRetry(async () => {
                    await this.#cloudHandler.upload(`${folder}/${ScriptPaths.ScriptFile}`, CloudBackupScripts.#encode(source))
                    await this.#cloudHandler.upload(`${folder}/${ScriptPaths.ScriptMetaFile}`, CloudBackupScripts.#encode(JSON.stringify(meta)))
                }, error => ({
                    headline: "Upload failed",
                    message: `Failed to upload script '${meta.name}'. '${error}'`,
                    approveText: "Retry",
                    cancelText: "Cancel"
                }))
                return [uuid, meta]
            }))
        const catalog = uploaded.reduce((scripts, [uuid, meta]) => {
            scripts[uuid] = meta
            return scripts
        }, {...cloud})
        await this.#uploadCatalog(catalog)
        progress(1.0)
    }

    async #trash(trashed: ReadonlyArray<UUID.String>, progress: Progress.Handler): Promise<void> {
        const {cloud} = this.#scriptDomains
        const obsolete = CloudBackupScripts.#entries(cloud).filter(([uuid]) => trashed.includes(uuid))
        if (obsolete.length > 0) {
            const approved = await RuntimeNotifier.approve({
                headline: "Delete Scripts?",
                message: `Found ${obsolete.length} locally deleted scripts. Delete from cloud as well?`,
                approveText: "Yes",
                cancelText: "No"
            })
            if (approved) {
                const deleted: ReadonlyArray<UUID.String> = await Promises.sequentialAll(
                    obsolete.map(([uuid, meta], index, {length}) => async () => {
                        progress((index + 1) / length)
                        this.#log(`Deleting '${meta.name}'`)
                        await this.#cloudHandler.delete(CloudBackupScripts.folderFor(uuid))
                        return uuid
                    }))
                const catalog = {...cloud}
                deleted.forEach(uuid => delete catalog[uuid])
                await this.#uploadCatalog(catalog)
            }
        }
        progress(1.0)
    }

    async #download(trashed: ReadonlyArray<UUID.String>, progress: Progress.Handler): Promise<void> {
        const {cloud, local} = this.#scriptDomains
        const missing = CloudBackupScripts.#entries(cloud)
            .filter(([uuid]) => isAbsent(local[uuid]) && !trashed.includes(uuid))
        const newer = CloudBackupScripts.#entries(cloud)
            .filter(([uuid, meta]) => {
                const localMeta = local[uuid]
                return isDefined(localMeta) && !isDefined(localMeta.stock)
                    && CloudBackupScripts.#time(meta) > CloudBackupScripts.#time(localMeta)
            })
        const overriding = newer.length === 0 ? Arrays.empty<Entry>() : await RuntimeNotifier.approve({
            headline: "Override Scripts?",
            message: `Found ${newer.length} scripts with newer versions in the cloud:\n\n${newer
                .map(([, meta]) => meta.name).join("\n")}\n\nOverride the local versions?`,
            approveText: "Override",
            cancelText: "Keep local"
        }).then(approved => approved ? newer : Arrays.empty<Entry>())
        const download = [...missing, ...overriding]
        if (download.length === 0) {
            this.#log("No scripts to download.")
            progress(1.0)
            return
        }
        await Promises.sequentialAll(download.map(([uuid, meta], index, {length}) => async () => {
            progress((index + 1) / length)
            this.#log(`Downloading script '${meta.name}'`)
            const folder = CloudBackupScripts.folderFor(uuid)
            const source = await Promises.guardedRetry(() =>
                this.#cloudHandler.download(`${folder}/${ScriptPaths.ScriptFile}`), network.defaultRetry)
            const metaBytes = await Promises.guardedRetry(() =>
                this.#cloudHandler.download(`${folder}/${ScriptPaths.ScriptMetaFile}`), network.defaultRetry)
            const decoder = new TextDecoder()
            await ScriptStorage.get().save(UUID.parse(uuid),
                ScriptMeta.fromJSON(JSON.parse(decoder.decode(metaBytes))), decoder.decode(source))
        }))
        this.#log("Download scripts complete.")
        progress(1.0)
    }

    async #uploadCatalog(catalog: Scripts): Promise<void> {
        this.#log("Uploading script catalog...")
        return this.#cloudHandler.upload(CloudBackupScripts.RemoteCatalogPath,
            CloudBackupScripts.#encode(JSON.stringify(catalog, null, 2)))
    }

    static #entries(scripts: Scripts): ReadonlyArray<Entry> {
        return Object.entries(scripts).map(([uuid, meta]) => [UUID.asString(uuid), meta])
    }

    static #time(meta: ScriptMeta): number {return new Date(meta.modified).getTime()}

    static #encode(text: string): ArrayBuffer {return new TextEncoder().encode(text).buffer as ArrayBuffer}
}
