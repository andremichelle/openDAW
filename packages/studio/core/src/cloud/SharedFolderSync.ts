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
    const AssetTimeoutMs = 60000
    const projectFolder = (uuid: UUID.Bytes): string => `projects/${UUID.toString(uuid)}`
    const sampleFolder = (uuid: UUID.Bytes): string => `assets/samples/${UUID.toString(uuid)}`
    const soundfontFolder = (uuid: UUID.Bytes): string => `assets/soundfonts/${UUID.toString(uuid)}`

    export const listProjects = async (cloudHandler: CloudHandler): Promise<ReadonlyArray<Listing>> => {
        const catalog = await downloadCatalog(cloudHandler)
        return Object.entries(catalog).map(([uuid, meta]) => ({uuid: UUID.parse(uuid), meta}))
    }

    export const saveProject = async (cloudHandler: CloudHandler,
                                      {uuid, project, meta, cover}: ProjectProfile,
                                      progress: Progress.Handler): Promise<number> => {
        const base = projectFolder(uuid)
        await cloudHandler.upload(`${base}/${ProjectPaths.ProjectFile}`, project.toArrayBuffer() as ArrayBuffer)
        await cloudHandler.upload(`${base}/${ProjectPaths.ProjectMetaFile}`, encodeJSON(meta))
        await cover.match({
            none: () => Promise.resolve(),
            some: buffer => cloudHandler.upload(`${base}/${ProjectPaths.ProjectCoverFile}`, buffer)
        })
        const audioFileBoxes = project.boxGraph.boxes()
            .filter((box): box is AudioFileBox => box instanceof AudioFileBox)
        const soundfontFileBoxes = project.boxGraph.boxes()
            .filter((box): box is SoundfontFileBox => box instanceof SoundfontFileBox)
        const advance = progressStep(audioFileBoxes.length + soundfontFileBoxes.length, progress)
        const sharedSamples = await listShared(cloudHandler, "assets/samples")
        const sharedSoundfonts = await listShared(cloudHandler, "assets/soundfonts")
        let failed = 0
        for (const box of audioFileBoxes) {
            const id = UUID.toString(box.address.uuid)
            if (!sharedSamples.has(id)) {
                const loader = project.sampleManager.getOrCreate(box.address.uuid)
                if (!await uploadSample(cloudHandler, loader)) {
                    failed++
                    console.warn(`[SharedFolderSync] could not upload sample '${box.fileName.getValue()}' (${id})`)
                }
            }
            advance()
        }
        for (const box of soundfontFileBoxes) {
            const id = UUID.toString(box.address.uuid)
            if (!sharedSoundfonts.has(id)) {
                const loader = project.soundfontManager.getOrCreate(box.address.uuid)
                if (!await uploadSoundfont(cloudHandler, loader)) {
                    failed++
                    console.warn(`[SharedFolderSync] could not upload soundfont (${id})`)
                }
            }
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
        return failed
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

    // Materializes the sample (downloading a library sample into local storage if needed) and uploads
    // it. The shared project must be self-contained, so library samples are bundled too. Returns false
    // if the sample cannot be materialized (e.g. the library is unavailable).
    const uploadSample = async (cloudHandler: CloudHandler, loader: SampleLoader): Promise<boolean> => {
        const local = `${SampleStorage.Folder}/${UUID.toString(loader.uuid)}`
        if (!await ensureLocal(local, "audio.wav", () => awaitSampleLoaded(loader))) {return false}
        const remote = sampleFolder(loader.uuid)
        const result = await Promises.tryCatch((async () => {
            await cloudHandler.upload(`${remote}/audio.wav`, await readOpfs(`${local}/audio.wav`))
            await cloudHandler.upload(`${remote}/peaks.bin`, await readOpfs(`${local}/peaks.bin`))
            await cloudHandler.upload(`${remote}/meta.json`, await readOpfs(`${local}/meta.json`))
        })())
        if (result.status === "rejected") {
            console.warn(`[SharedFolderSync] sample ${UUID.toString(loader.uuid)} upload failed:`, result.error)
        }
        return result.status === "resolved"
    }

    const uploadSoundfont = async (cloudHandler: CloudHandler, loader: SoundfontLoader): Promise<boolean> => {
        const local = `${SoundfontStorage.Folder}/${UUID.toString(loader.uuid)}`
        if (!await ensureLocal(local, "soundfont.sf2", () => awaitSoundfontLoaded(loader))) {return false}
        const remote = soundfontFolder(loader.uuid)
        const result = await Promises.tryCatch((async () => {
            await cloudHandler.upload(`${remote}/soundfont.sf2`, await readOpfs(`${local}/soundfont.sf2`))
            await cloudHandler.upload(`${remote}/meta.json`, await readOpfs(`${local}/meta.json`))
        })())
        if (result.status === "rejected") {
            console.warn(`[SharedFolderSync] soundfont ${UUID.toString(loader.uuid)} upload failed:`, result.error)
        }
        return result.status === "resolved"
    }

    // Ensures the asset files are in local storage. If the primary file is already there we use it
    // directly; otherwise we run the loader to fetch it from the library. False = could not obtain.
    const ensureLocal = async (folder: string, primaryFile: string,
                               materialize: () => Promise<void>): Promise<boolean> => {
        if (await localFileExists(folder, primaryFile)) {return true}
        const result = await Promises.tryCatch(withTimeout(materialize()))
        if (result.status === "rejected") {
            console.warn(`[SharedFolderSync] '${folder}' not in local storage and could not be fetched:`, result.error)
            return false
        }
        return true
    }

    const downloadSampleIfAbsent = async (cloudHandler: CloudHandler, uuid: UUID.Bytes): Promise<void> => {
        const local = `${SampleStorage.Folder}/${UUID.toString(uuid)}`
        if (await localFileExists(local, "audio.wav")) {return}
        const remote = sampleFolder(uuid)
        await writeOpfs(`${local}/audio.wav`, await cloudHandler.download(`${remote}/audio.wav`))
        await writeOpfs(`${local}/peaks.bin`, await cloudHandler.download(`${remote}/peaks.bin`))
        await writeOpfs(`${local}/meta.json`, await cloudHandler.download(`${remote}/meta.json`))
    }

    const downloadSoundfontIfAbsent = async (cloudHandler: CloudHandler, uuid: UUID.Bytes): Promise<void> => {
        const local = `${SoundfontStorage.Folder}/${UUID.toString(uuid)}`
        if (await localFileExists(local, "soundfont.sf2")) {return}
        const remote = soundfontFolder(uuid)
        await writeOpfs(`${local}/soundfont.sf2`, await cloudHandler.download(`${remote}/soundfont.sf2`))
        await writeOpfs(`${local}/meta.json`, await cloudHandler.download(`${remote}/meta.json`))
    }

    // Lists the UUID folder names already present under a shared asset folder so we can dedup in
    // memory, instead of probing each asset (which logs a 404 per missing asset in the console).
    const listShared = async (cloudHandler: CloudHandler, folder: string): Promise<Set<string>> => {
        const result = await Promises.tryCatch(cloudHandler.list(folder))
        return result.status === "resolved" ? new Set(result.value) : new Set<string>()
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

    // Checks presence by listing the parent folder, which does not open an exclusive file handle
    // and therefore cannot hang when the audio engine is holding the sample open.
    const localFileExists = async (folder: string, fileName: string): Promise<boolean> =>
        (await Workers.Opfs.list(folder)).some(entry => entry.name === fileName)

    // getOrCreate already triggers loading (from local storage, else fetched from the library and
    // persisted locally). We wait for that to finish so the bytes exist before uploading.
    const awaitSampleLoaded = (loader: SampleLoader): Promise<void> => {
        const state = loader.state
        if (state.type === "loaded") {return Promise.resolve()}
        if (state.type === "error") {return Promise.reject(new Error(state.reason))}
        const {promise, resolve, reject} = Promise.withResolvers<void>()
        const subscription = loader.subscribe(next => {
            if (next.type === "loaded") {subscription.terminate(); resolve()} else if (next.type === "error") {
                subscription.terminate()
                reject(new Error(next.reason))
            }
        })
        return promise
    }

    const awaitSoundfontLoaded = (loader: SoundfontLoader): Promise<void> => {
        const state = loader.state
        if (state.type === "loaded") {return Promise.resolve()}
        if (state.type === "error") {return Promise.reject(new Error(state.reason))}
        const {promise, resolve, reject} = Promise.withResolvers<void>()
        const subscription = loader.subscribe(next => {
            if (next.type === "loaded") {subscription.terminate(); resolve()} else if (next.type === "error") {
                subscription.terminate()
                reject(new Error(next.reason))
            }
        })
        return promise
    }

    // Bounds the library fetch so a sample that never loads cannot freeze the sync. Only guards
    // materialization, not uploads (a large file may legitimately take minutes to upload).
    const withTimeout = (operation: Promise<void>): Promise<void> => {
        const {promise, reject} = Promise.withResolvers<void>()
        const timer = setTimeout(() => reject(new Error(`timed out after ${AssetTimeoutMs}ms`)), AssetTimeoutMs)
        return Promise.race([operation, promise]).finally(() => clearTimeout(timer))
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
