import {Errors, isDefined, Option, panic, Procedure, Progress, TimeSpan, tryCatch, unitValue, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox, SoundfontFileBox} from "@opendaw/studio-boxes"
import {SampleLoader, SoundfontLoader} from "@opendaw/studio-adapters"
import {CloudHandler} from "./CloudHandler"
import {Project, ProjectEnv, ProjectMeta, ProjectPaths, ProjectProfile} from "../project"
import {Workers} from "../Workers"
import {SampleStorage} from "../samples"
import {SoundfontStorage} from "../soundfont"

// Reads/writes projects to a shared folder with deduplicated assets. Everything lives under a single
// `openDAW/` root, so the rest of the user's Nextcloud account stays clean for other apps. Layout:
//   openDAW/index.json catalog of projects
//   openDAW/projects/<uuid>/{project.od,meta.json, image.bin}
//   openDAW/assets/samples/<uuid>/{audio.wav,peaks.bin, meta.json} shared, uploaded once
//   openDAW/assets/soundfonts/<uuid>/{soundfont.sf2,meta.json} shared, uploaded once
export namespace SharedFolderSync {
    export type CatalogMeta = Pick<ProjectMeta, "name" | "modified" | "created" | "tags" | "description">
    // A project entry carries its metadata plus the UUIDs of every asset it references. The reference
    // graph lives here (not by scanning project.od files), so counting and GC are a single index read.
    export type CatalogEntry = {
        meta: CatalogMeta
        samples: ReadonlyArray<UUID.String>
        soundfonts: ReadonlyArray<UUID.String>
    }
    export type Catalog = { version: number, projects: Record<UUID.String, CatalogEntry> }
    export type Listing = { uuid: UUID.Bytes, entry: CatalogEntry }
    export type AssetCounts = { samples: number, soundfonts: number }
    // `value` is the byte-progress of the file currently uploading (0..1); `label` names it.
    export type SyncProgress = { value: unitValue, label: string }

    const CatalogVersion = 1
    // Single root folder for all openDAW data, so a student account can be used by other apps too.
    const Root = "openDAW"
    const IndexName = "index.json"
    const IndexPath = `${Root}/${IndexName}`
    const SamplesFolder = `${Root}/assets/samples`
    const SoundfontsFolder = `${Root}/assets/soundfonts`
    const ReadmeName = "README.txt"
    const ReadmePath = `${Root}/${ReadmeName}`
    const ReadmeText =
        "This folder is managed by openDAW (https://opendaw.studio).\n\n" +
        "Please do not rename, move, edit, or delete anything in here by hand.\n" +
        "openDAW keeps a catalog (index.json) and shares samples and soundfonts between projects.\n" +
        "Manual changes will corrupt that bookkeeping and break opening, saving, and asset cleanup."
    // Guards only the library fetch when a referenced sample is not in local storage, so a stalled
    // download cannot hang the sync. Does NOT apply to uploads, which may legitimately take minutes.
    const MaterializeTimeout = TimeSpan.minutes(2)
    const projectFolder = (uuid: UUID.Bytes): string => `${Root}/projects/${UUID.toString(uuid)}`
    const sampleFolder = (uuid: UUID.Bytes): string => `${SamplesFolder}/${UUID.toString(uuid)}`
    const soundfontFolder = (uuid: UUID.Bytes): string => `${SoundfontsFolder}/${UUID.toString(uuid)}`

    export const readCatalog = async (cloudHandler: CloudHandler): Promise<Catalog> => {
        if (!(await cloudHandler.list(Root)).includes(IndexName)) {return emptyCatalog()}
        const result = await Promises.tryCatch(cloudHandler.download(IndexPath))
        if (result.status === "rejected") {
            return result.error instanceof Errors.FileNotFound ? emptyCatalog() : panic(String(result.error))
        }
        return decodeCatalog(result.value)
    }

    // Parses index.json defensively: a malformed or unexpected shape (e.g. a missing `projects` map)
    // degrades to an empty catalog instead of throwing and breaking browse/save/delete.
    const decodeCatalog = (bytes: ArrayBuffer): Catalog => {
        const parsed = tryCatch(() => JSON.parse(new TextDecoder().decode(bytes)) as Partial<Catalog>)
        if (parsed.status === "failure") {return emptyCatalog()}
        const value = parsed.value
        return isDefined(value) && isDefined(value.projects)
            ? {version: CatalogVersion, projects: value.projects}
            : emptyCatalog()
    }

    export const listProjects = async (cloudHandler: CloudHandler): Promise<ReadonlyArray<Listing>> => {
        const catalog = await readCatalog(cloudHandler)
        return Object.entries(catalog.projects).map(([uuid, entry]) => ({uuid: UUID.parse(uuid), entry}))
    }

    // Distinct asset counts, derived from the in-memory catalog without any extra request.
    export const countAssets = (catalog: Catalog): AssetCounts => {
        const {samples, soundfonts} = collectLiveAssets(catalog)
        return {samples: samples.size, soundfonts: soundfonts.size}
    }

    // Removes a project and garbage-collects the assets it referenced that no longer belong to any
    // remaining project. Shared assets (still referenced elsewhere) are kept. `progress` advances over
    // the deletes (project folder + each orphan asset) and the final catalog upload.
    export const deleteProject = async (cloudHandler: CloudHandler, uuid: UUID.Bytes,
                                        progress?: Progress.Handler): Promise<void> => {
        const catalog = await readCatalog(cloudHandler)
        const key = UUID.toString(uuid)
        const removed = catalog.projects[key]
        if (!isDefined(removed)) {progress?.(1.0); return}
        delete catalog.projects[key]
        const live = collectLiveAssets(catalog)
        const orphanSamples = await existingOrphans(cloudHandler, SamplesFolder, removed.samples, live.samples)
        const orphanSoundfonts = await existingOrphans(cloudHandler, SoundfontsFolder, removed.soundfonts,
            live.soundfonts)
        // project folder + catalog upload + one step per orphan asset folder.
        const total = 2 + orphanSamples.length + orphanSoundfonts.length
        let done = 0
        const advance = () => progress?.(++done / total)
        await cloudHandler.delete(projectFolder(uuid))
        advance()
        for (const id of orphanSamples) {await cloudHandler.delete(`${SamplesFolder}/${id}`); advance()}
        for (const id of orphanSoundfonts) {await cloudHandler.delete(`${SoundfontsFolder}/${id}`); advance()}
        await cloudHandler.upload(IndexPath, encodeJSON(catalog))
        advance()
    }

    export const saveProject = async (cloudHandler: CloudHandler,
                                      {uuid, project, meta, cover}: ProjectProfile,
                                      onProgress: Procedure<SyncProgress>,
                                      signal?: AbortSignal): Promise<number> => {
        const checkAbort = () => {if (isDefined(signal) && signal.aborted) {throw Errors.AbortError}}
        const base = projectFolder(uuid)
        const audioFileBoxes = project.boxGraph.boxes()
            .filter((box): box is AudioFileBox => box instanceof AudioFileBox)
        const soundfontFileBoxes = project.boxGraph.boxes()
            .filter((box): box is SoundfontFileBox => box instanceof SoundfontFileBox)
        const assetCount = audioFileBoxes.length + soundfontFileBoxes.length
        const totalUnits = 1 + assetCount
        let unit = 0
        // Overall progress: each unit (the project, then each asset) fills its 1/totalUnits slice
        // smoothly via byte progress, so the bar always advances and never sits at a per-file 100%.
        const report = (value: unitValue, label: string) =>
            onProgress({value: (unit + value) / totalUnits, label})
        onProgress({value: 0, label: "Preparing project"})
        await ensureReadme(cloudHandler)
        await cloudHandler.upload(`${base}/${ProjectPaths.ProjectFile}`, project.toArrayBuffer() as ArrayBuffer,
            value => report(value, "Uploading project"))
        await cloudHandler.upload(`${base}/${ProjectPaths.ProjectMetaFile}`, encodeJSON(meta))
        await cover.match({
            none: () => Promise.resolve(),
            some: buffer => cloudHandler.upload(`${base}/${ProjectPaths.ProjectCoverFile}`, buffer)
        })
        unit = 1
        // index.json is the source of truth for what is already uploaded, so dedup against it rather
        // than probing folders. An asset is recorded in the project entry only once it is actually
        // present (already known, or uploaded just now); a failed upload is left out and re-attempted
        // on the next save (self-healing), and never makes the catalog claim an asset that is not there.
        const catalog = await readCatalog(cloudHandler)
        const key = UUID.toString(uuid)
        const previous = catalog.projects[key]
        const known = collectLiveAssets(catalog)
        let failed = 0
        const presentSamples = new Set<UUID.String>()
        for (const box of audioFileBoxes) {
            checkAbort()
            const id = UUID.toString(box.address.uuid)
            const label = `Uploading sample ${unit}/${assetCount}: ${box.fileName.getValue()}`
            if (known.samples.has(id) || presentSamples.has(id)) {
                presentSamples.add(id)
            } else if (await uploadSample(cloudHandler, project.sampleManager.getOrCreate(box.address.uuid),
                value => report(value, label))) {
                presentSamples.add(id)
            } else {
                failed++
                console.warn(`[SharedFolderSync] could not upload sample '${box.fileName.getValue()}' (${id})`)
            }
            unit++
        }
        const presentSoundfonts = new Set<UUID.String>()
        for (const box of soundfontFileBoxes) {
            checkAbort()
            const id = UUID.toString(box.address.uuid)
            const label = `Uploading soundfont ${unit}/${assetCount}: ${box.fileName.getValue()}`
            if (known.soundfonts.has(id) || presentSoundfonts.has(id)) {
                presentSoundfonts.add(id)
            } else if (await uploadSoundfont(cloudHandler, project.soundfontManager.getOrCreate(box.address.uuid),
                value => report(value, label))) {
                presentSoundfonts.add(id)
            } else {
                failed++
                console.warn(`[SharedFolderSync] could not upload soundfont (${id})`)
            }
            unit++
        }
        onProgress({value: 1.0, label: "Updating catalog"})
        catalog.projects[key] = {
            meta: {
                name: meta.name,
                modified: meta.modified,
                created: meta.created,
                tags: meta.tags,
                description: meta.description
            },
            samples: [...presentSamples],
            soundfonts: [...presentSoundfonts]
        }
        // Re-saving may drop an asset the project used to reference; GC it if no project keeps it alive.
        if (isDefined(previous)) {await deleteOrphans(cloudHandler, previous, collectLiveAssets(catalog))}
        await cloudHandler.upload(IndexPath, encodeJSON(catalog))
        return failed
    }

    export const openProject = async (env: ProjectEnv,
                                      cloudHandler: CloudHandler,
                                      uuid: UUID.Bytes,
                                      progress: Progress.Handler,
                                      signal?: AbortSignal): Promise<ProjectProfile> => {
        const checkAbort = () => {if (isDefined(signal) && signal.aborted) {throw Errors.AbortError}}
        const base = projectFolder(uuid)
        const projectData = await cloudHandler.download(`${base}/${ProjectPaths.ProjectFile}`)
        const project = await Project.loadAnyVersion(env, projectData)
        const meta = JSON.parse(new TextDecoder()
            .decode(await cloudHandler.download(`${base}/${ProjectPaths.ProjectMetaFile}`))) as ProjectMeta
        const projectFiles = await cloudHandler.list(base)
        const cover = projectFiles.includes(ProjectPaths.ProjectCoverFile)
            ? Option.wrap(await cloudHandler.download(`${base}/${ProjectPaths.ProjectCoverFile}`))
            : Option.None
        const audioFileBoxes = project.boxGraph.boxes().filter(box => box instanceof AudioFileBox)
        const soundfontFileBoxes = project.boxGraph.boxes().filter(box => box instanceof SoundfontFileBox)
        const advance = progressStep(audioFileBoxes.length + soundfontFileBoxes.length, progress)
        for (const {address: {uuid: assetUUID}} of audioFileBoxes) {
            checkAbort()
            await downloadSampleIfAbsent(cloudHandler, assetUUID)
            advance()
        }
        for (const {address: {uuid: assetUUID}} of soundfontFileBoxes) {
            checkAbort()
            await downloadSoundfontIfAbsent(cloudHandler, assetUUID)
            advance()
        }
        progress(1.0)
        return new ProjectProfile(uuid, project, meta, cover)
    }

    // Materializes the sample (downloading a library sample into local storage if needed) and uploads
    // it. The shared project must be self-contained, so library samples are bundled too. Returns false
    // if the sample cannot be materialized (e.g. the library is unavailable).
    const uploadSample = async (cloudHandler: CloudHandler, loader: SampleLoader,
                                onProgress: Progress.Handler): Promise<boolean> => {
        const local = `${SampleStorage.Folder}/${UUID.toString(loader.uuid)}`
        if (!await ensureLocal(local, "audio.wav", () => awaitSampleLoaded(loader))) {return false}
        const remote = sampleFolder(loader.uuid)
        const result = await Promises.tryCatch((async () => {
            await cloudHandler.upload(`${remote}/audio.wav`, await readOpfs(`${local}/audio.wav`), onProgress)
            await cloudHandler.upload(`${remote}/peaks.bin`, await readOpfs(`${local}/peaks.bin`))
            await cloudHandler.upload(`${remote}/meta.json`, await readOpfs(`${local}/meta.json`))
        })())
        if (result.status === "rejected") {
            console.warn(`[SharedFolderSync] sample ${UUID.toString(loader.uuid)} upload failed:`, result.error)
            // Remove the partially-written folder so it is not mistaken for a complete asset later.
            await Promises.tryCatch(cloudHandler.delete(remote))
        }
        return result.status === "resolved"
    }

    const uploadSoundfont = async (cloudHandler: CloudHandler, loader: SoundfontLoader,
                                   onProgress: Progress.Handler): Promise<boolean> => {
        const local = `${SoundfontStorage.Folder}/${UUID.toString(loader.uuid)}`
        if (!await ensureLocal(local, "soundfont.sf2", () => awaitSoundfontLoaded(loader))) {return false}
        const remote = soundfontFolder(loader.uuid)
        const result = await Promises.tryCatch((async () => {
            await cloudHandler.upload(`${remote}/soundfont.sf2`, await readOpfs(`${local}/soundfont.sf2`), onProgress)
            await cloudHandler.upload(`${remote}/meta.json`, await readOpfs(`${local}/meta.json`))
        })())
        if (result.status === "rejected") {
            console.warn(`[SharedFolderSync] soundfont ${UUID.toString(loader.uuid)} upload failed:`, result.error)
            // Remove the partially-written folder so it is not mistaken for a complete asset later.
            await Promises.tryCatch(cloudHandler.delete(remote))
        }
        return result.status === "resolved"
    }

    // Ensures the asset files are in local storage. If the primary file is already there we use it
    // directly; otherwise we run the loader to fetch it from the library. False = could not obtain.
    const ensureLocal = async (folder: string, primaryFile: string,
                               materialize: () => Promise<void>): Promise<boolean> => {
        if (await localFileExists(folder, primaryFile)) {return true}
        const result = await Promises.tryCatch(Promises.timeout(materialize(), MaterializeTimeout, "library fetch timed out"))
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
    // memory. Walks down from the root, listing only folders that exist (each returns 207), so a
    // not-yet-created assets folder never triggers a 404 in the console.
    const listShared = async (cloudHandler: CloudHandler, folder: string): Promise<Set<string>> => {
        let children = await cloudHandler.list("")
        let current = ""
        for (const segment of folder.split("/")) {
            if (!children.includes(segment)) {return new Set<string>()}
            current = current.length === 0 ? segment : `${current}/${segment}`
            children = await cloudHandler.list(current)
        }
        return new Set(children)
    }

    const emptyCatalog = (): Catalog => ({version: CatalogVersion, projects: {}})

    // The "live set": every asset UUID still referenced by any project. GC keeps these and deletes
    // the rest. Recomputed from the project list each time so it self-heals under last-write-wins.
    const collectLiveAssets = (catalog: Catalog): { samples: Set<UUID.String>, soundfonts: Set<UUID.String> } => {
        const samples = new Set<UUID.String>()
        const soundfonts = new Set<UUID.String>()
        for (const entry of Object.values(catalog.projects)) {
            entry.samples.forEach(id => samples.add(id))
            entry.soundfonts.forEach(id => soundfonts.add(id))
        }
        return {samples, soundfonts}
    }

    // Deletes the asset folders referenced by `entry` that are absent from the live set (used by the
    // re-save GC, where no progress is reported).
    const deleteOrphans = async (cloudHandler: CloudHandler, entry: CatalogEntry,
                                 live: { samples: Set<UUID.String>, soundfonts: Set<UUID.String> }): Promise<void> => {
        for (const id of await existingOrphans(cloudHandler, SamplesFolder, entry.samples, live.samples)) {
            await cloudHandler.delete(`${SamplesFolder}/${id}`)
        }
        for (const id of await existingOrphans(cloudHandler, SoundfontsFolder, entry.soundfonts, live.soundfonts)) {
            await cloudHandler.delete(`${SoundfontsFolder}/${id}`)
        }
    }

    // The orphan ids under `folder` that actually exist on the server (looked up via one listing), so a
    // stale catalog reference never triggers a 404 DELETE in the console.
    const existingOrphans = async (cloudHandler: CloudHandler, folder: string,
                                   referenced: ReadonlyArray<UUID.String>,
                                   live: Set<UUID.String>): Promise<ReadonlyArray<UUID.String>> => {
        const orphans = referenced.filter(id => !live.has(id))
        if (orphans.length === 0) {return []}
        const existing = await listShared(cloudHandler, folder)
        return orphans.filter(id => existing.has(id))
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

    const readOpfs = async (path: string): Promise<ArrayBuffer> => {
        const bytes = await Workers.Opfs.read(path)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }

    const writeOpfs = (path: string, data: ArrayBuffer): Promise<void> => Workers.Opfs.write(path, new Uint8Array(data))

    const encodeText = (text: string): ArrayBuffer => {
        const bytes = new TextEncoder().encode(text)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }

    const encodeJSON = (value: unknown): ArrayBuffer => encodeText(JSON.stringify(value))

    // Drops a human-readable warning into the openDAW root once, so anyone browsing the Nextcloud files
    // knows not to touch them by hand. Written only if absent, so it never overwrites/repeats.
    const ensureReadme = async (cloudHandler: CloudHandler): Promise<void> => {
        if ((await cloudHandler.list(Root)).includes(ReadmeName)) {return}
        await cloudHandler.upload(ReadmePath, encodeText(ReadmeText))
    }

    const progressStep = (total: number, progress: Progress.Handler): (() => void) => {
        let completed = 0
        return () => progress(total === 0 ? 1.0 : ++completed / total)
    }
}
