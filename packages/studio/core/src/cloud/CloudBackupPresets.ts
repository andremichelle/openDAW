import {Arrays, Errors, panic, Procedure, Progress, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"
import {OpenPresetAPI, PresetMeta, PresetStorage} from "../presets"

type PresetDomains = Record<"stock" | "local" | "cloud", ReadonlyArray<PresetMeta>>

export class CloudBackupPresets {
    static readonly RemotePath = "presets"
    static readonly RemoteCatalogPath = `${this.RemotePath}/index.json`
    static readonly arePresetsEqual = ({uuid: a}: PresetMeta, {uuid: b}: PresetMeta) => a === b

    static pathFor(uuid: UUID.String): string {return `${this.RemotePath}/${uuid}.odp`}

    static async start(cloudHandler: CloudHandler,
                       progress: Progress.Handler,
                       log: Procedure<string>) {
        log("Collecting all preset domains...")
        const [stock, local, cloud] = await Promise.all([
            OpenPresetAPI.get().list(),
            PresetStorage.readIndex(),
            cloudHandler.download(CloudBackupPresets.RemoteCatalogPath)
                .then(json => JSON.parse(new TextDecoder().decode(json)))
                .catch(reason => reason instanceof Errors.FileNotFound ? Arrays.empty() : panic(reason))
        ])
        return new CloudBackupPresets(cloudHandler, {stock, local, cloud}, log).#start(progress)
    }

    readonly #cloudHandler: CloudHandler
    readonly #presetDomains: PresetDomains
    readonly #log: Procedure<string>

    private constructor(cloudHandler: CloudHandler,
                        presetDomains: PresetDomains,
                        log: Procedure<string>) {
        this.#cloudHandler = cloudHandler
        this.#presetDomains = presetDomains
        this.#log = log
    }

    async #start(progress: Progress.Handler) {
        const trashed = await PresetStorage.loadTrashedIds()
        const [uploadProgress, trashProgress, downloadProgress] = Progress.splitWithWeights(progress, [0.45, 0.10, 0.45])
        await this.#upload(uploadProgress)
        await this.#trash(trashed, trashProgress)
        await this.#download(trashed, downloadProgress)
    }

    async #upload(progress: Progress.Handler) {
        const {stock, local, cloud} = this.#presetDomains
        const maybeUnsyncedPresets = Arrays.subtract(local, stock, CloudBackupPresets.arePresetsEqual)
        const unsyncedPresets = Arrays.subtract(maybeUnsyncedPresets, cloud, CloudBackupPresets.arePresetsEqual)
        if (unsyncedPresets.length === 0) {
            this.#log("No unsynced presets found.")
            progress(1.0)
            return
        }
        const uploadedPresets = await Promises.sequentialAll(unsyncedPresets.map((preset, index, {length}) =>
            async () => {
                progress((index + 1) / length)
                this.#log(`Uploading preset '${preset.name}'`)
                const arrayBuffer = await PresetStorage.load(UUID.parse(preset.uuid))
                const path = CloudBackupPresets.pathFor(preset.uuid)
                await Promises.approvedRetry(() => this.#cloudHandler.upload(path, arrayBuffer), error => ({
                    headline: "Upload failed",
                    message: `Failed to upload preset '${preset.name}'. '${error}'`,
                    approveText: "Retry",
                    cancelText: "Cancel"
                }))
                return preset
            }))
        const catalog: Array<PresetMeta> = Arrays.merge(cloud, uploadedPresets, CloudBackupPresets.arePresetsEqual)
        await this.#uploadCatalog(catalog)
        progress(1.0)
    }

    async #trash(trashed: ReadonlyArray<UUID.String>, progress: Progress.Handler) {
        const {cloud} = this.#presetDomains
        const obsolete = Arrays.intersect(cloud, trashed, (preset, uuid) => preset.uuid === uuid)
        if (obsolete.length === 0) {
            progress(1.0)
            return
        }
        const approved = await RuntimeNotifier.approve({
            headline: "Delete Presets?",
            message: `Found ${obsolete.length} locally deleted presets. Delete from cloud as well?`,
            approveText: "Yes",
            cancelText: "No"
        })
        if (!approved) {
            progress(1.0)
            return
        }
        const result: ReadonlyArray<PresetMeta> = await Promises.sequentialAll(
            obsolete.map((preset, index, {length}) => async () => {
                progress((index + 1) / length)
                this.#log(`Deleting '${preset.name}'`)
                await this.#cloudHandler.delete(CloudBackupPresets.pathFor(preset.uuid))
                return preset
            }))
        const catalog = cloud.slice()
        result.forEach(preset => Arrays.removeIf(catalog, ({uuid}) => preset.uuid === uuid))
        await this.#uploadCatalog(catalog)
        progress(1.0)
    }

    async #download(trashed: ReadonlyArray<UUID.String>, progress: Progress.Handler) {
        const {cloud, local} = this.#presetDomains
        const missingLocally = Arrays.subtract(cloud, local, CloudBackupPresets.arePresetsEqual)
        const download = Arrays.subtract(missingLocally, trashed, (preset, uuid) => preset.uuid === uuid)
        if (download.length === 0) {
            this.#log("No presets to download.")
            progress(1.0)
            return
        }
        await Promises.sequentialAll(download.map((preset, index, {length}) =>
            async () => {
                progress((index + 1) / length)
                this.#log(`Downloading preset '${preset.name}'`)
                const path = CloudBackupPresets.pathFor(preset.uuid)
                const buffer = await Promises.guardedRetry(() => this.#cloudHandler.download(path), network.defaultRetry)
                await PresetStorage.save(preset, buffer)
                return preset
            }))
        this.#log("Download presets complete.")
        progress(1.0)
    }

    async #uploadCatalog(catalog: ReadonlyArray<PresetMeta>) {
        this.#log("Uploading preset catalog...")
        const jsonString = JSON.stringify(catalog, null, 2)
        const buffer = new TextEncoder().encode(jsonString).buffer
        return this.#cloudHandler.upload(CloudBackupPresets.RemoteCatalogPath, buffer)
    }
}