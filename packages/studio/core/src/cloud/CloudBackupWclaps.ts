import {Arrays, Errors, panic, Procedure, Progress} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"
import {WclapStorage} from "../wclap/WclapStorage"

// Locally imported WebCLAP bundles, content addressed by sha256, mirrored as `wclaps/<sha256>.tar.gz`
export class CloudBackupWclaps {
    static readonly RemotePath = "wclaps"
    static readonly RemoteCatalogPath = `${this.RemotePath}/index.json`

    static pathFor(id: string): string {return `${this.RemotePath}/${id}.tar.gz`}

    static async start(cloudHandler: CloudHandler, progress: Progress.Handler, log: Procedure<string>) {
        log("Collecting WebCLAP bundles...")
        const [local, cloud] = await Promise.all([
            WclapStorage.list(),
            cloudHandler.download(CloudBackupWclaps.RemoteCatalogPath)
                .then(json => JSON.parse(new TextDecoder().decode(json)) as ReadonlyArray<string>)
                .catch(reason => reason instanceof Errors.FileNotFound ? Arrays.empty<string>() : panic(reason))
        ])
        return new CloudBackupWclaps(cloudHandler, local, cloud, log).#start(progress)
    }

    readonly #cloudHandler: CloudHandler
    readonly #local: ReadonlyArray<string>
    readonly #cloud: ReadonlyArray<string>
    readonly #log: Procedure<string>

    private constructor(cloudHandler: CloudHandler, local: ReadonlyArray<string>, cloud: ReadonlyArray<string>,
                        log: Procedure<string>) {
        this.#cloudHandler = cloudHandler
        this.#local = local
        this.#cloud = cloud
        this.#log = log
    }

    async #start(progress: Progress.Handler) {
        const [uploadProgress, downloadProgress] = Progress.split(progress, 2)
        await this.#upload(uploadProgress)
        await this.#download(downloadProgress)
    }

    async #upload(progress: Progress.Handler) {
        const unsynced = this.#local.filter(id => !this.#cloud.includes(id))
        if (unsynced.length === 0) {
            progress(1.0)
            return
        }
        const uploaded = await Promises.sequentialAll(unsynced.map((id, index, {length}) => async () => {
            progress((index + 1) / length)
            this.#log(`Uploading WebCLAP bundle ${id.substring(0, 8)}`)
            const archive = await WclapStorage.loadId(id)
            await Promises.approvedRetry(() => this.#cloudHandler.upload(CloudBackupWclaps.pathFor(id), archive), error => ({
                headline: "Upload failed",
                message: `Failed to upload a WebCLAP bundle. '${error}'`,
                approveText: "Retry",
                cancelText: "Cancel"
            }))
            return id
        }))
        await this.#uploadCatalog([...this.#cloud, ...uploaded])
        progress(1.0)
    }

    async #download(progress: Progress.Handler) {
        const missing = this.#cloud.filter(id => !this.#local.includes(id))
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
            await WclapStorage.save(id, archive)
        }))
        progress(1.0)
    }

    async #uploadCatalog(catalog: ReadonlyArray<string>) {
        const buffer = new TextEncoder().encode(JSON.stringify(catalog, null, 2)).buffer
        return this.#cloudHandler.upload(CloudBackupWclaps.RemoteCatalogPath, buffer)
    }
}
