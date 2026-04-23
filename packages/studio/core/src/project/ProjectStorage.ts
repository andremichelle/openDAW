import {Class, Option, Progress, safeExecute, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioFileBox, SoundfontFileBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Promises} from "@opendaw/lib-runtime"
import {ProjectMeta} from "./ProjectMeta"
import {Workers} from "../Workers"
import {ProjectPaths} from "./ProjectPaths"

export namespace ProjectStorage {
    export type ListEntry = {
        uuid: UUID.Bytes
        meta: ProjectMeta
        cover?: ArrayBuffer
        project?: ArrayBuffer
    }

    export type List = ReadonlyArray<ListEntry>

    export const listProjects = async ({includeCover, includeProject, progress}: {
        includeCover?: boolean
        includeProject?: boolean
        progress?: Progress.Handler
    } = {}): Promise<List> => {
        return Workers.Opfs.list(ProjectPaths.Folder)
            .then(files => Promise.all(files.filter(file => file.kind === "directory")
                .map(async ({name}, index, {length}) => {
                    safeExecute(progress, (index + 1) / length)
                    const uuid = UUID.parse(name)
                    const array = await Workers.Opfs.read(ProjectPaths.projectMeta(uuid))
                    return ({
                        uuid,
                        meta: JSON.parse(new TextDecoder().decode(array)) as ProjectMeta,
                        cover: includeCover ? (await loadCover(uuid)).unwrapOrUndefined() : undefined,
                        project: includeProject ? await loadProject(uuid) : undefined
                    } satisfies ListEntry)
                })))
    }

    export const loadProject = async (uuid: UUID.Bytes): Promise<ArrayBuffer> => {
        return Workers.Opfs.read(ProjectPaths.projectFile(uuid)).then(array => array.buffer as ArrayBuffer)
    }

    export const loadMeta = async (uuid: UUID.Bytes): Promise<ArrayBuffer> => {
        return Workers.Opfs.read(ProjectPaths.projectMeta(uuid)).then(array => array.buffer as ArrayBuffer)
    }

    export const loadCover = async (uuid: UUID.Bytes): Promise<Option<ArrayBuffer>> => {
        return Workers.Opfs.read(ProjectPaths.projectCover(uuid))
            .then(array => Option.wrap(array.buffer as ArrayBuffer), () => Option.None)
    }

    export const listUsedAssets = async (
        type: Class<AudioFileBox | SoundfontFileBox>
    ): Promise<Map<UUID.String, Array<string>>> => {
        console.debug("listUsedAssets", type.name)
        const result = new Map<UUID.String, Array<string>>()
        const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const files = await Workers.Opfs.list(ProjectPaths.Folder)
        for (const {name: folder} of files.filter(file => file.kind === "directory")) {
            const uuid = UUID.parse(folder)
            const projectBytes = await Promises.tryCatch(Workers.Opfs.read(ProjectPaths.projectFile(uuid)))
            if (projectBytes.status === "rejected") {continue}
            const metaBytes = await Promises.tryCatch(Workers.Opfs.read(ProjectPaths.projectMeta(uuid)))
            const projectName = metaBytes.status === "rejected" ? folder
                : (JSON.parse(new TextDecoder().decode(metaBytes.value)) as ProjectMeta).name
            const decoded = tryCatch(() => ProjectSkeleton.decode(exactBuffer(projectBytes.value)))
            if (decoded.status === "failure") {
                console.warn(`listUsedAssets: failed to decode project '${projectName}'`, decoded.error)
                continue
            }
            for (const box of decoded.value.boxGraph.boxes()) {
                if (!(box instanceof type)) {continue}
                const key = UUID.toString(box.address.uuid)
                const list = result.get(key) ?? []
                if (!list.includes(projectName)) {list.push(projectName)}
                result.set(key, list)
            }
        }
        return result
    }

    export const deleteProject = async (uuid: UUID.Bytes) => {
        const array = await loadTrashedIds()
        array.push(UUID.toString(uuid))
        const trash = new TextEncoder().encode(JSON.stringify(array))
        await Workers.Opfs.write(`${ProjectPaths.Folder}/trash.json`, trash)
        await Workers.Opfs.delete(ProjectPaths.projectFolder(uuid))
    }

    export const loadTrashedIds = async (): Promise<Array<UUID.String>> => {
        const {status, value} = await Promises.tryCatch(Workers.Opfs.read(`${ProjectPaths.Folder}/trash.json`))
        return status === "rejected" ? [] : JSON.parse(new TextDecoder().decode(value))
    }
}