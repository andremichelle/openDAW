import {
    Arrays,
    Errors,
    isAbsent,
    Maybe,
    Objects,
    panic,
    Procedure,
    Progress,
    Provider,
    RuntimeNotifier,
    TimeSpan,
    UUID
} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {ProjectMeta} from "../project/ProjectMeta"
import {TemplateStorage} from "../project/TemplateStorage"
import {CloudHandler} from "./CloudHandler"
import {Workers} from "../Workers"
import {TemplatePaths} from "../project/TemplatePaths"

// these get indexed in the cloud with the uuid in the cloud's catalog
const catalogFields = ["name", "modified", "created", "tags", "description"] as const

type CatalogFields = typeof catalogFields[number]
type MetaFields = Pick<ProjectMeta, CatalogFields>
type Templates = Record<UUID.String, MetaFields>
type TemplateDomains = Record<"local" | "cloud", Templates>

export class CloudBackupTemplates {
    static readonly RemotePath = "templates"
    static readonly RemoteCatalogPath = `${this.RemotePath}/index.json`

    static async start(cloudHandler: CloudHandler,
                       progress: Progress.Handler,
                       log: Procedure<string>) {
        log("Collecting all template domains...")
        const [local, cloud] = await Promise.all([
            TemplateStorage.listTemplates()
                .then(list => list.reduce((record: Templates, entry: TemplateStorage.ListEntry) => {
                    record[UUID.toString(entry.uuid)] = Objects.include(entry.meta, ...catalogFields)
                    return record
                }, {})),
            cloudHandler.download(CloudBackupTemplates.RemoteCatalogPath)
                .then(json => JSON.parse(new TextDecoder().decode(json)))
                .catch(reason => reason instanceof Errors.FileNotFound ? Arrays.empty() : panic(reason))
        ])
        return new CloudBackupTemplates(cloudHandler, {local, cloud}, log).#start(progress)
    }

    readonly #cloudHandler: CloudHandler
    readonly #templateDomains: TemplateDomains
    readonly #log: Procedure<string>

    private constructor(cloudHandler: CloudHandler, templateDomains: TemplateDomains, log: Procedure<string>) {
        this.#cloudHandler = cloudHandler
        this.#templateDomains = templateDomains
        this.#log = log
    }

    async #start(progress: Progress.Handler): Promise<void> {
        const trashed = await TemplateStorage.loadTrashedIds()
        const [uploadProgress, trashProgress, downloadProgress] = Progress.splitWithWeights(progress, [0.45, 0.10, 0.45])
        await this.#upload(uploadProgress)
        await this.#trash(trashed, trashProgress)
        await this.#download(trashed, downloadProgress)
    }

    async #upload(progress: Progress.Handler): Promise<void> {
        const {local, cloud} = this.#templateDomains
        const isUnsynced = (localTemplate: MetaFields, cloudTemplate: Maybe<MetaFields>) =>
            isAbsent(cloudTemplate)
            || new Date(cloudTemplate.modified).getTime() < new Date(localTemplate.modified).getTime()
        const unsyncedTemplates: ReadonlyArray<[UUID.String, MetaFields]> = Object.entries(local)
            .filter(([uuid, localTemplate]) => isUnsynced(localTemplate, cloud[uuid as UUID.String]))
            .map(([uuid, localTemplate]) => ([UUID.asString(uuid), localTemplate]))
        if (unsyncedTemplates.length === 0) {
            this.#log("No unsynced templates found.")
            progress(1.0)
            return
        }
        const uploaded = await Promises.sequentialAll(unsyncedTemplates
            .map(([uuidAsString, meta]: [UUID.String, MetaFields], index, {length}) => async () => {
                progress((index + 1) / length)
                this.#log(`Uploading template '${meta.name}'`)
                const uuid = UUID.parse(uuidAsString)
                const folder = `${CloudBackupTemplates.RemotePath}/${uuidAsString}`
                const metaFile = await TemplateStorage.loadMeta(uuid)
                const projectFile = await TemplateStorage.loadTemplate(uuid)
                const optCoverFile = await TemplateStorage.loadCover(uuid)
                const tasks: Array<Provider<Promise<void>>> = []
                const removeProjectPath = `${folder}/project.od`
                const remoteMetaPath = `${folder}/meta.json`
                tasks.push(() => this.#cloudHandler.upload(removeProjectPath, projectFile))
                tasks.push(() => this.#cloudHandler.upload(remoteMetaPath, metaFile))
                optCoverFile.ifSome(cover => {
                    const removeCoverPath = `${folder}/image.bin`
                    return tasks.push(() => this.#cloudHandler.upload(removeCoverPath, cover))
                })
                await Promises.approvedRetry(() =>
                    Promises.timeout(Promises.sequentialAll(tasks),
                        TimeSpan.minutes(10), "Upload timeout (10 min)."), error => ({
                    headline: "Upload failed",
                    message: `Failed to upload template '${meta.name}'. '${error}'`,
                    approveText: "Retry",
                    cancelText: "Cancel"
                }))
                return {uuidAsString, meta}
            }))
        const catalog = uploaded
            .reduce((templates, template) => {
                templates[UUID.asString(template.uuidAsString)] = template.meta
                return templates
            }, {...cloud})
        await this.#uploadCatalog(catalog)
        progress(1.0)
    }

    async #trash(trashed: ReadonlyArray<UUID.String>, progress: Progress.Handler): Promise<void> {
        const {cloud} = this.#templateDomains
        const obsolete: Array<[string, MetaFields]> =
            Arrays.intersect(Object.entries(cloud), trashed, ([uuid, _], trashed) => uuid === trashed)
        if (obsolete.length > 0) {
            const approved = await RuntimeNotifier.approve({
                headline: "Delete Templates?",
                message: `Found ${obsolete.length} locally deleted templates. Delete from cloud as well?`,
                approveText: "Yes",
                cancelText: "No"
            })
            if (approved) {
                const deleted: ReadonlyArray<UUID.String> = await Promises.sequentialAll(
                    obsolete.map(([uuid, meta], index, {length}) => async () => {
                        progress((index + 1) / length)
                        const path = `${CloudBackupTemplates.RemotePath}/${uuid}`
                        this.#log(`Deleting '${meta.name}'`)
                        await this.#cloudHandler.delete(path)
                        return UUID.asString(uuid)
                    }))
                const catalog = {...cloud}
                deleted.forEach(uuid => delete catalog[uuid])
                await this.#uploadCatalog(catalog)
            }
        }
        progress(1.0)
    }

    async #download(trashed: ReadonlyArray<UUID.String>, progress: Progress.Handler): Promise<void> {
        const {cloud, local} = this.#templateDomains
        const compareFn = ([uuidA]: [string, MetaFields], [uuidB]: [string, MetaFields]) => uuidA === uuidB
        const missingLocally = Arrays.subtract(Object.entries(cloud), Object.entries(local), compareFn)
        const download = Arrays.subtract(missingLocally, trashed, ([templateUUID], uuid) => templateUUID === uuid)
        if (download.length === 0) {
            this.#log("No templates to download.")
            progress(1.0)
            return
        }
        await Promises.sequentialAll(
            download.map(([uuidAsString, meta], index, {length}) => async () => {
                progress((index + 1) / length)
                const uuid = UUID.parse(uuidAsString)
                const path = `${CloudBackupTemplates.RemotePath}/${uuidAsString}`
                this.#log(`Downloading template '${meta.name}'`)
                const files = await Promises.guardedRetry(() =>
                    this.#cloudHandler.list(path), network.defaultRetry)
                const hasProjectFile = files.includes("project.od")
                const hasMetaFile = files.includes("meta.json")
                if (!hasProjectFile || !hasMetaFile) {
                    console.warn(`hasProjectFile: ${hasProjectFile}, hasMetaFile: ${hasMetaFile} for ${uuidAsString}`)
                    const approvedDeletion = await RuntimeNotifier.approve({
                        headline: "Download failed",
                        message: `Template '${meta.name}' is corrupted. Delete it from cloud?.`,
                        approveText: "Yes",
                        cancelText: "Ignore"
                    })
                    if (approvedDeletion) {
                        await this.#cloudHandler.delete(path)
                    } else {
                        return uuidAsString
                    }
                }
                const projectPath = `${path}/project.od`
                const metaPath = `${path}/meta.json`
                const coverPath = `${path}/image.bin`
                const projectArrayBuffer = await Promises.guardedRetry(() =>
                    this.#cloudHandler.download(projectPath), network.defaultRetry)
                const metaArrayBuffer = await Promises.guardedRetry(() =>
                    this.#cloudHandler.download(metaPath), network.defaultRetry)
                await Workers.Opfs.write(TemplatePaths.projectFile(uuid), new Uint8Array(projectArrayBuffer))
                await Workers.Opfs.write(TemplatePaths.projectMeta(uuid), new Uint8Array(metaArrayBuffer))
                const hasCover = files.some(file => file.endsWith("image.bin"))
                if (hasCover) {
                    const arrayBuffer = await Promises.guardedRetry(() =>
                        this.#cloudHandler.download(coverPath), network.defaultRetry)
                    await Workers.Opfs.write(TemplatePaths.projectCover(uuid), new Uint8Array(arrayBuffer))
                }
                return uuidAsString
            }))
        this.#log("Download templates complete.")
        progress(1.0)
    }

    async #uploadCatalog(catalog: Templates): Promise<void> {
        this.#log("Uploading template catalog...")
        const jsonString = JSON.stringify(catalog, null, 2)
        const buffer = new TextEncoder().encode(jsonString).buffer
        return this.#cloudHandler.upload(CloudBackupTemplates.RemoteCatalogPath, buffer)
    }
}
