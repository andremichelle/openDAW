import {Errors, Option, panic, Progress, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox, SoundfontFileBox} from "@opendaw/studio-boxes"
import {SampleLoader, SoundfontLoader} from "@opendaw/studio-adapters"
import {CloudHandler} from "./CloudHandler"
import {Project, ProjectEnv, ProjectMeta, ProjectPaths, ProjectProfile} from "../project"
import {Workers} from "../Workers"
import {SampleStorage} from "../samples"
import {SoundfontStorage} from "../soundfont"

// Reads/writes projects to a shared folder with deduplicated assets. Layout:
//   index.json catalog of projects
//   projects/<uuid>/{project.od,meta.json, image.bin}
//   assets/samples/<uuid>/{audio.wav,peaks.bin, meta.json} shared, uploaded once
//   assets/soundfonts/<uuid>/{soundfont.sf2,meta.json} shared, uploaded once
export namespace SharedFolderSync {
    export type CatalogEntry = Pick<ProjectMeta, "name" | "modified" | "created" | "tags" | "description">
    export type Catalog = Record<UUID.String, CatalogEntry>
    export type Listing = { uuid: UUID.Bytes, meta: CatalogEntry }

    const IndexPath = "index.json"
    const projectFolder = (uuid: UUID.Bytes): string => `projects/${UUID.toString(uuid)}`
    const sampleFolder = (uuid: UUID.Bytes): string => `assets/samples/${UUID.toString(uuid)}`
    const soundfontFolder = (uuid: UUID.Bytes): string => `assets/soundfonts/${UUID.toString(uuid)}`

    export const listProjects = async (cloudHandler: CloudHandler): Promise<ReadonlyArray<Listing>> => {
        const catalog = await downloadCatalog(cloudHandler)
        return Object.entries(catalog).map(([uuid, meta]) => ({uuid: UUID.parse(uuid), meta}))
    }

    export const saveProject = async (cloudHandler: CloudHandler,
                                      {uuid, project, meta, cover}: ProjectProfile,
                                      progress: Progress.Handler): Promise<void> => {
        const base = projectFolder(uuid)
        await cloudHandler.upload(`${base}/${ProjectPaths.ProjectFile}`, project.toArrayBuffer() as ArrayBuffer)
        await cloudHandler.upload(`${base}/${ProjectPaths.ProjectMetaFile}`, encodeJSON(meta))
        await cover.match({
            none: () => Promise.resolve(),
            some: buffer => cloudHandler.upload(`${base}/${ProjectPaths.ProjectCoverFile}`, buffer)
        })
        const audioFileBoxes = project.boxGraph.boxes().filter(box => box instanceof AudioFileBox)
        const soundfontFileBoxes = project.boxGraph.boxes().filter(box => box instanceof SoundfontFileBox)
        const advance = progressStep(audioFileBoxes.length + soundfontFileBoxes.length, progress)
        for (const {address: {uuid: assetUUID}} of audioFileBoxes) {
            await uploadSampleIfAbsent(cloudHandler, project.sampleManager.getOrCreate(assetUUID))
            advance()
        }
        for (const {address: {uuid: assetUUID}} of soundfontFileBoxes) {
            await uploadSoundfontIfAbsent(cloudHandler, project.soundfontManager.getOrCreate(assetUUID))
            advance()
        }
        const catalog = await downloadCatalog(cloudHandler)
        catalog[UUID.toString(uuid)] = {
            name: meta.name,
            modified: meta.modified,
            created: meta.created,
            tags: meta.tags,
            description: meta.description
        }
        await cloudHandler.upload(IndexPath, encodeJSON(catalog))
        progress(1.0)
    }

    export const openProject = async (env: ProjectEnv,
                                      cloudHandler: CloudHandler,
                                      uuid: UUID.Bytes,
                                      progress: Progress.Handler): Promise<ProjectProfile> => {
        const base = projectFolder(uuid)
        const projectData = await cloudHandler.download(`${base}/${ProjectPaths.ProjectFile}`)
        const project = await Project.loadAnyVersion(env, projectData)
        const meta = JSON.parse(new TextDecoder()
            .decode(await cloudHandler.download(`${base}/${ProjectPaths.ProjectMetaFile}`))) as ProjectMeta
        const cover = await downloadOptional(cloudHandler, `${base}/${ProjectPaths.ProjectCoverFile}`)
        const audioFileBoxes = project.boxGraph.boxes().filter(box => box instanceof AudioFileBox)
        const soundfontFileBoxes = project.boxGraph.boxes().filter(box => box instanceof SoundfontFileBox)
        const advance = progressStep(audioFileBoxes.length + soundfontFileBoxes.length, progress)
        for (const {address: {uuid: assetUUID}} of audioFileBoxes) {
            await downloadSampleIfAbsent(cloudHandler, assetUUID)
            advance()
        }
        for (const {address: {uuid: assetUUID}} of soundfontFileBoxes) {
            await downloadSoundfontIfAbsent(cloudHandler, assetUUID)
            advance()
        }
        progress(1.0)
        return new ProjectProfile(uuid, project, meta, cover)
    }

    const uploadSampleIfAbsent = async (cloudHandler: CloudHandler, loader: SampleLoader): Promise<void> => {
        const remote = sampleFolder(loader.uuid)
        if (await cloudHandler.exists(`${remote}/audio.wav`)) {return}
        await awaitSampleLoaded(loader)
        const local = `${SampleStorage.Folder}/${UUID.toString(loader.uuid)}`
        await cloudHandler.upload(`${remote}/audio.wav`, await readOpfs(`${local}/audio.wav`))
        await cloudHandler.upload(`${remote}/peaks.bin`, await readOpfs(`${local}/peaks.bin`))
        await cloudHandler.upload(`${remote}/meta.json`, await readOpfs(`${local}/meta.json`))
    }

    const uploadSoundfontIfAbsent = async (cloudHandler: CloudHandler, loader: SoundfontLoader): Promise<void> => {
        const remote = soundfontFolder(loader.uuid)
        if (await cloudHandler.exists(`${remote}/soundfont.sf2`)) {return}
        await awaitSoundfontLoaded(loader)
        const local = `${SoundfontStorage.Folder}/${UUID.toString(loader.uuid)}`
        await cloudHandler.upload(`${remote}/soundfont.sf2`, await readOpfs(`${local}/soundfont.sf2`))
        await cloudHandler.upload(`${remote}/meta.json`, await readOpfs(`${local}/meta.json`))
    }

    const downloadSampleIfAbsent = async (cloudHandler: CloudHandler, uuid: UUID.Bytes): Promise<void> => {
        const local = `${SampleStorage.Folder}/${UUID.toString(uuid)}`
        if (await Workers.Opfs.exists(`${local}/audio.wav`)) {return}
        const remote = sampleFolder(uuid)
        await writeOpfs(`${local}/audio.wav`, await cloudHandler.download(`${remote}/audio.wav`))
        await writeOpfs(`${local}/peaks.bin`, await cloudHandler.download(`${remote}/peaks.bin`))
        await writeOpfs(`${local}/meta.json`, await cloudHandler.download(`${remote}/meta.json`))
    }

    const downloadSoundfontIfAbsent = async (cloudHandler: CloudHandler, uuid: UUID.Bytes): Promise<void> => {
        const local = `${SoundfontStorage.Folder}/${UUID.toString(uuid)}`
        if (await Workers.Opfs.exists(`${local}/soundfont.sf2`)) {return}
        const remote = soundfontFolder(uuid)
        await writeOpfs(`${local}/soundfont.sf2`, await cloudHandler.download(`${remote}/soundfont.sf2`))
        await writeOpfs(`${local}/meta.json`, await cloudHandler.download(`${remote}/meta.json`))
    }

    const downloadCatalog = async (cloudHandler: CloudHandler): Promise<Catalog> => {
        const result = await Promises.tryCatch(cloudHandler.download(IndexPath))
        if (result.status === "rejected") {
            return result.error instanceof Errors.FileNotFound ? {} : panic(String(result.error))
        }
        return JSON.parse(new TextDecoder().decode(result.value)) as Catalog
    }

    const downloadOptional = async (cloudHandler: CloudHandler, path: string): Promise<Option<ArrayBuffer>> => {
        const result = await Promises.tryCatch(cloudHandler.download(path))
        return result.status === "resolved" ? Option.wrap(result.value) : Option.None
    }

    const awaitSampleLoaded = (loader: SampleLoader): Promise<void> => {
        if (loader.state.type === "loaded") {return Promise.resolve()}
        return new Promise<void>((resolve, reject) => {
            const subscription = loader.subscribe(state => {
                if (state.type === "loaded") {
                    resolve()
                    subscription.terminate()
                } else if (state.type === "error") {
                    reject(new Error(state.reason))
                    subscription.terminate()
                }
            })
        })
    }

    const awaitSoundfontLoaded = (loader: SoundfontLoader): Promise<void> => {
        if (loader.state.type === "loaded") {return Promise.resolve()}
        return new Promise<void>((resolve, reject) => {
            const subscription = loader.subscribe(state => {
                if (state.type === "loaded") {
                    resolve()
                    subscription.terminate()
                } else if (state.type === "error") {
                    reject(new Error(state.reason))
                    subscription.terminate()
                }
            })
        })
    }

    const readOpfs = async (path: string): Promise<ArrayBuffer> => {
        const bytes = await Workers.Opfs.read(path)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }

    const writeOpfs = (path: string, data: ArrayBuffer): Promise<void> => Workers.Opfs.write(path, new Uint8Array(data))

    const encodeJSON = (value: unknown): ArrayBuffer => {
        const bytes = new TextEncoder().encode(JSON.stringify(value))
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }

    const progressStep = (total: number, progress: Progress.Handler): (() => void) => {
        let completed = 0
        return () => progress(total === 0 ? 1.0 : ++completed / total)
    }
}
