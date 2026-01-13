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
} from "@moises-ai/lib-std"
import {network, Promises} from "@moises-ai/lib-runtime"
import {ProjectMeta} from "../project/ProjectMeta"
import {ProjectStorage} from "../project/ProjectStorage"
import {CloudHandler} from "./CloudHandler"
import {Workers} from "../Workers"
import {ProjectPaths} from "../project/ProjectPaths"

// these get indexed in the cloud with the uuid in the cloud's catalog
const catalogFields = ["name", "modified", "created", "tags", "description"] as const

type CatalogFields = typeof catalogFields[number]
type MetaFields = Pick<ProjectMeta, CatalogFields>
type Projects = Record<UUID.String, MetaFields>
type ProjectDomains = Record<"local" | "cloud", Projects>

export class CloudBackupProjects {
    static readonly RemotePath = "projects"
    static readonly RemoteCatalogPath = `${this.RemotePath}/index.json`

    static async start(cloudHandler: CloudHandler,
                       progress: Progress.Handler,
                       log: Procedure<string>) {
        log("Collecting all project domains...")
        const [local, cloud] = await Promise.all([
            ProjectStorage.listProjects()
                .then(list => list.reduce((record: Projects, entry: ProjectStorage.ListEntry) => {
                    record[UUID.toString(entry.uuid)] = Objects.include(entry.meta, ...catalogFields)
                    return record
                }, {})),
            cloudHandler.download(CloudBackupProjects.RemoteCatalogPath)
                .then(json => JSON.parse(new TextDecoder().decode(json)))
                .catch(reason => reason instanceof Errors.FileNotFound ? Arrays.empty() : panic(reason))
        ])
        return new CloudBackupProjects(cloudHandler, {local, cloud}, log).#start(progress)
    }

    readonly #cloudHandler: CloudHandler
    readonly #projectDomains: ProjectDomains
    readonly #log: Procedure<string>

    private constructor(cloudHandler: CloudHandler, projectDomains: ProjectDomains, log: Procedure<string>) {
        this.#cloudHandler = cloudHandler
        this.#projectDomains = projectDomains
        this.#log = log
    }

    async #start(progress: Progress.Handler): Promise<void> {
        const trashed = await ProjectStorage.loadTrashedIds()
        const [uploadProgress, trashProgress, downloadProgress] = Progress.splitWithWeights(progress, [0.45, 0.10, 0.45])
        await this.#upload(uploadProgress)
        await this.#trash(trashed, trashProgress)
        await this.#download(trashed, downloadProgress)
    }

    async #upload(progress: Progress.Handler): Promise<void> {
        const {local, cloud} = this.#projectDomains
        const isUnsynced = (localProject: MetaFields, cloudProject: Maybe<MetaFields>) =>
            isAbsent(cloudProject)
            || new Date(cloudProject.modified).getTime() < new Date(localProject.modified).getTime()
        const unsyncedProjects: ReadonlyArray<[UUID.String, MetaFields]> = Object.entries(local)
            .filter(([uuid, localProject]) => isUnsynced(localProject, cloud[uuid as UUID.String]))
            .map(([uuid, localProject]) => ([UUID.asString(uuid), localProject]))
        if (unsyncedProjects.length === 0) {
            this.#log("No unsynced projects found.")
            progress(1.0)
            return
        }
        const uploaded = await Promises.sequentialAll(unsyncedProjects
            .map(([uuidAsString, meta]: [UUID.String, MetaFields], index, {length}) => async () => {
                progress((index + 1) / length)
                this.#log(`Uploading project '${meta.name}'`)
                const uuid = UUID.parse(uuidAsString)
                const folder = `${CloudBackupProjects.RemotePath}/${uuidAsString}`
                const metaFile = await ProjectStorage.loadMeta(uuid)
                const projectFile = await ProjectStorage.loadProject(uuid)
                const optCoverFile = await ProjectStorage.loadCover(uuid)
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
                    message: `Failed to upload project '${meta.name}'. '${error}'`,
                    approveText: "Retry",
                    cancelText: "Cancel"
                }))
                return {uuidAsString, meta}
            }))
        const catalog = uploaded
            .reduce((projects, project) => {
                projects[UUID.asString(project.uuidAsString)] = project.meta
                return projects
            }, {...cloud})
        await this.#uploadCatalog(catalog)
        progress(1.0)
    }

    async #trash(trashed: ReadonlyArray<UUID.String>, progress: Progress.Handler): Promise<void> {
        const {cloud} = this.#projectDomains
        const obsolete: Array<[string, MetaFields]> =
            Arrays.intersect(Object.entries(cloud), trashed, ([uuid, _], trashed) => uuid === trashed)
        if (obsolete.length > 0) {
            const approved = await RuntimeNotifier.approve({
                headline: "Delete Projects?",
                message: `Found ${obsolete.length} locally deleted projects. Delete from cloud as well?`,
                approveText: "Yes",
                cancelText: "No"
            })
            if (approved) {
                const deleted: ReadonlyArray<UUID.String> = await Promises.sequentialAll(
                    obsolete.map(([uuid, meta], index, {length}) => async () => {
                        progress((index + 1) / length)
                        const path = `${CloudBackupProjects.RemotePath}/${uuid}`
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
        const {cloud, local} = this.#projectDomains
        const compareFn = ([uuidA]: [string, MetaFields], [uuidB]: [string, MetaFields]) => uuidA === uuidB
        const missingLocally = Arrays.subtract(Object.entries(cloud), Object.entries(local), compareFn)
        const download = Arrays.subtract(missingLocally, trashed, ([projectUUID], uuid) => projectUUID === uuid)
        if (download.length === 0) {
            this.#log("No projects to download.")
            progress(1.0)
            return
        }
        await Promises.sequentialAll(
            download.map(([uuidAsString, meta], index, {length}) => async () => {
                progress((index + 1) / length)
                const uuid = UUID.parse(uuidAsString)
                const path = `${CloudBackupProjects.RemotePath}/${uuidAsString}`
                this.#log(`Downloading project '${meta.name}'`)
                const files = await Promises.guardedRetry(() =>
                    this.#cloudHandler.list(path), network.defaultRetry)
                const hasProjectFile = files.includes("project.od")
                const hasMetaFile = files.includes("meta.json")
                if (!hasProjectFile || !hasMetaFile) {
                    console.warn(`hasProjectFile: ${hasProjectFile}, hasMetaFile: ${hasMetaFile} for ${uuidAsString}`)
                    const approvedDeletion = await RuntimeNotifier.approve({
                        headline: "Download failed",
                        message: `Project '${meta.name}' is corrupted. Delete it from cloud?.`,
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
                await Workers.Opfs.write(ProjectPaths.projectFile(uuid), new Uint8Array(projectArrayBuffer))
                await Workers.Opfs.write(ProjectPaths.projectMeta(uuid), new Uint8Array(metaArrayBuffer))
                const hasCover = files.some(file => file.endsWith("image.bin"))
                if (hasCover) {
                    const arrayBuffer = await Promises.guardedRetry(() =>
                        this.#cloudHandler.download(coverPath), network.defaultRetry)
                    await Workers.Opfs.write(ProjectPaths.projectCover(uuid), new Uint8Array(arrayBuffer))
                }
                return uuidAsString
            }))
        this.#log("Download projects complete.")
        progress(1.0)
    }

    async #uploadCatalog(catalog: Projects): Promise<void> {
        this.#log("Uploading project catalog...")
        const jsonString = JSON.stringify(catalog, null, 2)
        const buffer = new TextEncoder().encode(jsonString).buffer
        return this.#cloudHandler.upload(CloudBackupProjects.RemoteCatalogPath, buffer)
    }
}