import {Class, Option, Progress, safeExecute, tryCatch, UUID} from "@moises-ai/lib-std"
import {AudioFileBox, SoundfontFileBox} from "@moises-ai/studio-boxes"
import {ProjectSkeleton} from "@moises-ai/studio-adapters"
import {Promises} from "@moises-ai/lib-runtime"
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

    export const listUsedAssets = async (type: Class<AudioFileBox | SoundfontFileBox>): Promise<Set<string>> => {
        const uuids: Array<string> = []
        const files = await Workers.Opfs.list(ProjectPaths.Folder)
        for (const {name} of files.filter(file => file.kind === "directory")) {
            const result = await Workers.Opfs.read(ProjectPaths.projectFile(UUID.parse(name)))
            tryCatch(() => {
                const {boxGraph} = ProjectSkeleton.decode(result.buffer)
                uuids.push(...boxGraph.boxes()
                    .filter(box => box instanceof type)
                    .map((box) => UUID.toString(box.address.uuid)))
            })
        }
        return new Set<string>(uuids)
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