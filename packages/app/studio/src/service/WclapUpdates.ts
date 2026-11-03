import {ByteArrayInput, EmptyProcedure, isDefined, Optional, Option, Progress, tryCatch, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {PresetHeader, ProjectSkeleton} from "@opendaw/studio-adapters"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectMeta, ProjectPaths, TemplatePaths, WclapBoxes, WclapStates, WclapStorage, Workers} from "@opendaw/studio-core"
import {BoxGraph} from "@opendaw/lib-box"
import {WclapCatalog} from "@/opendaw-api/WclapCatalog"
import {WclapIndexEntry} from "@/opendaw-api/WclapIndex"
import {StorageInspector} from "@/storage/StorageInspector"
import {StorageReport} from "@/storage/StorageReport"
import {StorageScan} from "@/storage/StorageScan"
import {StudioService} from "@/service/StudioService"

// Stored WebCLAP builds the catalogue has replaced: the projects using them move to the newer build (the same plugin,
// so it reads its state), the old builds no project uses anymore can go
export namespace WclapUpdates {
    export type Outdated = { readonly id: string, readonly successor: WclapIndexEntry }

    // kept: old builds still in use after the update, with what uses them
    export type Kept = { readonly name: string, readonly users: ReadonlyArray<string> }

    export type Result = {
        readonly projects: number, readonly presets: number, readonly devices: number,
        readonly deleted: number, readonly kept: ReadonlyArray<Kept>
    }

    // a replaced build leaves the index, the newer entry keeps its id (and every older one) in supersedes
    export const find = async (): Promise<ReadonlyArray<Outdated>> => {
        const [stored, published] = await Promise.all([WclapStorage.list(), WclapCatalog.get().all()])
        const successors = new Map<string, WclapIndexEntry>()
        published.forEach(entry => entry.supersedes.forEach(id => successors.set(id, entry)))
        return stored.flatMap(id => {
            const successor = successors.get(id)
            return isDefined(successor) && successor.uuid !== id ? [{id, successor}] : []
        })
    }

    export const run = async (service: StudioService, outdated: ReadonlyArray<Outdated>,
                              {update, deleteOld}: { update: boolean, deleteOld: boolean },
                              progress: Progress.Handler = EmptyProcedure): Promise<Result> => {
        const result: { -readonly [K in keyof Result]: Result[K] } =
            {projects: 0, presets: 0, devices: 0, deleted: 0, kept: []}
        if (update) {
            const urls = await download(outdated, value => progress(value * 0.5))
            const open: Array<string> = []
            service.projectProfileService.getValue().ifSome(({uuid, project}) => {
                open.push(UUID.toString(uuid))
                const boxes = project.boxGraph.boxes().filter(WclapBoxes.is).filter(box => isDefined(next(urls, box)))
                if (boxes.length === 0) {return}
                new Set([...urls.values()].map(({url}) => url)).forEach(url => service.engine.wclapRetry(url))
                // one undo step: an undo hands every device its old build again
                project.editing.modify(() => boxes.forEach(box => WclapStates.select(box, next(urls, box)!, box.clapId.getValue())))
                result.projects++
                result.devices += boxes.length
            })
            // the open project's saved file too: saving it later stores the same builds, else its old ones stay in use
            const folders = [{root: ProjectPaths.Folder, file: ProjectPaths.projectFile, meta: ProjectPaths.projectMeta},
                {root: TemplatePaths.Folder, file: TemplatePaths.projectFile, meta: TemplatePaths.projectMeta}]
            for (const [index, folder] of folders.entries()) {
                const entries = await Workers.Opfs.list(folder.root).catch(() => [])
                const uuids = entries.filter(entry => entry.kind === "directory").map(entry => entry.name)
                for (const [position, name] of uuids.entries()) {
                    const devices = await rewrite(UUID.parse(name), folder.file, folder.meta, urls)
                    if (devices > 0 && !open.includes(name)) {
                        result.projects++
                        result.devices += devices
                    }
                    progress(0.5 + 0.4 * (index + (position + 1) / uuids.length) / folders.length)
                }
            }
            // a user preset holding a WebCLAP device keeps its old build in use as much as a project does
            const presets = await Workers.Opfs.list(PresetFolder).catch(() => [])
            for (const {name} of presets.filter(entry => entry.kind === "file" && entry.name.endsWith(".odp"))) {
                const devices = await rewritePreset(`${PresetFolder}${name}`, urls)
                if (devices > 0) {
                    result.presets++
                    result.devices += devices
                }
            }
        }
        if (deleteOld) {
            const {deleted, kept} = await removeUnused(service, outdated)
            result.deleted = deleted
            result.kept = kept
        }
        progress(1.0)
        return result
    }

    // the newer builds, stored before any device points to them
    const download = async (outdated: ReadonlyArray<Outdated>, progress: Progress.Handler): Promise<Map<string, Next>> => {
        const successors = new Map(outdated.map(({successor}) => [successor.uuid, successor]))
        const urls = new Map<string, Next>()
        for (const [index, successor] of [...successors.values()].entries()) {
            if (!await WclapStorage.exists(successor.uuid)) {
                const url = await WclapStorage.store(await WclapCatalog.get().load(successor.uuid,
                    value => progress((index + value) / successors.size)))
                if (url !== WclapStorage.urlOf(successor.uuid)) {throw new Error(`${successor.name}: the download does not match its id`)}
            }
            progress((index + 1) / successors.size)
        }
        outdated.forEach(({id, successor}) => urls.set(WclapStorage.urlOf(id),
            {url: WclapStorage.urlOf(successor.uuid), clapIds: new Set(successor.plugins.map(({clapId}) => clapId))}))
        return urls
    }

    type Next = { readonly url: string, readonly clapIds: ReadonlySet<string> }

    // only a build offering the device's plugin replaces it
    const next = (urls: ReadonlyMap<string, Next>, box: WclapBoxes.Any): Optional<string> => {
        const found = urls.get(box.url.getValue())
        return isDefined(found) && found.clapIds.has(box.clapId.getValue()) ? found.url : undefined
    }

    const rewrite = async (uuid: UUID.Bytes, file: (uuid: UUID.Bytes) => string, meta: (uuid: UUID.Bytes) => string,
                           urls: ReadonlyMap<string, Next>): Promise<number> => {
        const bytes = await Promises.tryCatch(Workers.Opfs.read(file(uuid)))
        if (bytes.status === "rejected") {return 0}
        const decoded = tryCatch(() => ProjectSkeleton.decode(exact(bytes.value)))
        if (decoded.status === "failure") {
            console.warn(`WclapUpdates: could not decode ${file(uuid)}`, decoded.error)
            return 0
        }
        const graph: BoxGraph = decoded.value.boxGraph
        const boxes = graph.boxes().filter(WclapBoxes.is).filter(box => isDefined(next(urls, box)))
        if (boxes.length === 0) {return 0}
        graph.beginTransaction()
        boxes.forEach(box => WclapStates.select(box, next(urls, box)!, box.clapId.getValue()))
        graph.endTransaction()
        await Workers.Opfs.write(file(uuid), new Uint8Array(ProjectSkeleton.encode(graph)))
        const metaBytes = await Promises.tryCatch(Workers.Opfs.read(meta(uuid)))
        if (metaBytes.status === "resolved") {
            const parsed = tryCatch(() => ProjectMeta.fromJSON(JSON.parse(new TextDecoder().decode(metaBytes.value))))
            if (parsed.status === "success") {
                parsed.value.modified = new Date().toISOString()
                await Workers.Opfs.write(meta(uuid), new TextEncoder().encode(JSON.stringify(parsed.value)))
            }
        }
        return boxes.length
    }

    const PresetFolder = "presets/user/"

    // a preset is its 8-byte header (magic, version) and the box graph
    const rewritePreset = async (path: string, urls: ReadonlyMap<string, Next>): Promise<number> => {
        const bytes = await Promises.tryCatch(Workers.Opfs.read(path))
        if (bytes.status === "rejected") {return 0}
        const buffer = exact(bytes.value)
        const header = new ByteArrayInput(buffer)
        if (header.readInt() !== PresetHeader.MAGIC_HEADER_OPEN || header.readInt() !== PresetHeader.FORMAT_VERSION) {return 0}
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const decoded = tryCatch(() => graph.fromArrayBuffer(buffer.slice(8), false))
        if (decoded.status === "failure") {
            console.warn(`WclapUpdates: could not decode ${path}`, decoded.error)
            return 0
        }
        const boxes = graph.boxes().filter(WclapBoxes.is).filter(box => isDefined(next(urls, box)))
        if (boxes.length === 0) {return 0}
        graph.beginTransaction()
        boxes.forEach(box => WclapStates.select(box, next(urls, box)!, box.clapId.getValue()))
        graph.endTransaction()
        const body = new Uint8Array(graph.toArrayBuffer())
        const out = new Uint8Array(8 + body.length)
        out.set(new Uint8Array(buffer, 0, 8))
        out.set(body, 8)
        await Workers.Opfs.write(path, out)
        return boxes.length
    }

    // an old build still used somewhere (a project not updated, a preset, the open project's saved file) stays
    const removeUnused = async (service: StudioService, outdated: ReadonlyArray<Outdated>)
        : Promise<{ deleted: number, kept: ReadonlyArray<Kept> }> => {
        const scanned = await StorageInspector.scan(EmptyProcedure, EmptyProcedure)
        const report = service.projectProfileService.getValue().match({
            none: () => scanned,
            some: profile => StorageReport.withOpenProject(scanned, UUID.toString(profile.uuid),
                StorageScan.referencesOf(profile.project.boxGraph).refs)
        })
        const openId: Optional<string> = service.projectProfileService.getValue()
            .map(profile => UUID.toString(profile.uuid)).unwrapOrUndefined()
        let deleted = 0
        const kept: Array<Kept> = []
        for (const {id, successor} of outdated) {
            const usedBy = report.assets.find(asset => StorageReport.isSame(asset, {kind: "wclap", id}))?.usedBy ?? []
            if (usedBy.length > 0) {
                kept.push({
                    name: successor.name,
                    users: usedBy.map(ref => ref.kind === "project" && ref.id === openId ? "the open project"
                        : `${report.items.find(item => StorageReport.isSame(item, ref))?.name ?? ref.id} (${ref.kind})`)
                })
                continue
            }
            await WclapStorage.remove(id)
            deleted++
        }
        return {deleted, kept}
    }

    const exact = (bytes: Uint8Array): ArrayBuffer =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
