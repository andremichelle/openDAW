import {Class, Option, Progress, safeExecute, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioFileBox, SoundfontFileBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Promises} from "@opendaw/lib-runtime"
import {ProjectMeta} from "./ProjectMeta"
import {ProjectProfile} from "./ProjectProfile"
import {Workers} from "../Workers"
import {TemplatePaths} from "./TemplatePaths"

export namespace TemplateStorage {
    export type ListEntry = {
        uuid: UUID.Bytes
        meta: ProjectMeta
        cover?: ArrayBuffer
        project?: ArrayBuffer
    }

    export type List = ReadonlyArray<ListEntry>

    export const listTemplates = async ({includeCover, includeProject, progress}: {
        includeCover?: boolean
        includeProject?: boolean
        progress?: Progress.Handler
    } = {}): Promise<List> => {
        return Workers.Opfs.list(TemplatePaths.Folder)
            .then(files => Promise.all(files.filter(file => file.kind === "directory")
                .map(async ({name}, index, {length}) => {
                    safeExecute(progress, (index + 1) / length)
                    const uuid = UUID.parse(name)
                    const array = await Workers.Opfs.read(TemplatePaths.projectMeta(uuid))
                    return ({
                        uuid,
                        meta: ProjectMeta.fromJSON(JSON.parse(new TextDecoder().decode(array))),
                        cover: includeCover ? (await loadCover(uuid)).unwrapOrUndefined() : undefined,
                        project: includeProject ? await loadTemplate(uuid) : undefined
                    } satisfies ListEntry)
                })))
    }

    export const exists = async (uuid: UUID.Bytes): Promise<boolean> =>
        (await Promises.tryCatch(Workers.Opfs.read(TemplatePaths.projectMeta(uuid)))).status === "resolved"

    export const loadTemplate = async (uuid: UUID.Bytes): Promise<ArrayBuffer> => {
        return Workers.Opfs.read(TemplatePaths.projectFile(uuid)).then(array => array.buffer as ArrayBuffer)
    }

    export const loadMeta = async (uuid: UUID.Bytes): Promise<ArrayBuffer> => {
        return Workers.Opfs.read(TemplatePaths.projectMeta(uuid)).then(array => array.buffer as ArrayBuffer)
    }

    export const loadCover = async (uuid: UUID.Bytes): Promise<Option<ArrayBuffer>> => {
        return Workers.Opfs.read(TemplatePaths.projectCover(uuid))
            .then(array => Option.wrap(array.buffer as ArrayBuffer), () => Option.None)
    }

    export const saveAsTemplate = async (profile: ProjectProfile, name: string): Promise<void> => {
        const uuid = UUID.generate()
        const project = profile.project.copy()
        const meta = ProjectMeta.copy(profile.meta)
        delete meta.radioToken // never carry a publish token into a template
        const template = new ProjectProfile(uuid, project, meta, profile.cover, true)
        template.updateMetaData("name", name)
        template.updateMetaData("created", new Date().toISOString())
        template.updateModifyDate()
        await Workers.Opfs.write(TemplatePaths.projectFile(uuid), new Uint8Array(project.toArrayBuffer()))
        await Workers.Opfs.write(TemplatePaths.projectMeta(uuid),
            new TextEncoder().encode(JSON.stringify(template.meta)))
        await profile.cover.match({
            none: () => Promise.resolve(),
            some: cover => Workers.Opfs.write(TemplatePaths.projectCover(uuid), new Uint8Array(cover))
        })
    }

    export const listUsedAssets = async (
        type: Class<AudioFileBox | SoundfontFileBox>
    ): Promise<Map<UUID.String, Array<string>>> => {
        console.debug("listUsedAssets", type.name)
        const result = new Map<UUID.String, Array<string>>()
        const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const files = await Workers.Opfs.list(TemplatePaths.Folder)
        for (const {name: folder} of files.filter(file => file.kind === "directory")) {
            const uuid = UUID.parse(folder)
            const projectBytes = await Promises.tryCatch(Workers.Opfs.read(TemplatePaths.projectFile(uuid)))
            if (projectBytes.status === "rejected") {continue}
            const metaBytes = await Promises.tryCatch(Workers.Opfs.read(TemplatePaths.projectMeta(uuid)))
            const templateName = metaBytes.status === "rejected" ? folder
                : ProjectMeta.fromJSON(JSON.parse(new TextDecoder().decode(metaBytes.value))).name
            const decoded = tryCatch(() => ProjectSkeleton.decode(exactBuffer(projectBytes.value)))
            if (decoded.status === "failure") {
                console.warn(`listUsedAssets: failed to decode template '${templateName}'`, decoded.error)
                continue
            }
            for (const box of decoded.value.boxGraph.boxes()) {
                if (!(box instanceof type)) {continue}
                const key = UUID.toString(box.address.uuid)
                const list = result.get(key) ?? []
                if (!list.includes(templateName)) {list.push(templateName)}
                result.set(key, list)
            }
        }
        return result
    }

    export const deleteTemplate = async (uuid: UUID.Bytes) => {
        const array = await loadTrashedIds()
        array.push(UUID.toString(uuid))
        const trash = new TextEncoder().encode(JSON.stringify(array))
        await Workers.Opfs.write(`${TemplatePaths.Folder}/trash.json`, trash)
        await Workers.Opfs.delete(TemplatePaths.templateFolder(uuid))
    }

    export const loadTrashedIds = async (): Promise<Array<UUID.String>> => {
        const {status, value} = await Promises.tryCatch(Workers.Opfs.read(`${TemplatePaths.Folder}/trash.json`))
        return status === "rejected" ? [] : JSON.parse(new TextDecoder().decode(value))
    }
}
