import JSZip from "jszip"
import {Xml} from "@opendaw/lib-xml"
import {asDefined, panic, UUID} from "@opendaw/lib-std"
import {MetaDataSchema, ProjectSchema} from "@opendaw/lib-dawproject"

export namespace DawProjectIO {
    export type Resource = { uuid: UUID.Format, path: string, name: string, buffer: ArrayBuffer }

    export interface Resources {
        fromPath(path: string): Resource
        fromUUID(uuid: UUID.Format): Resource
    }

    export const decode = async (buffer: ArrayBuffer | NonSharedBuffer): Promise<{
        metaData: MetaDataSchema,
        project: ProjectSchema,
        resources: Resources
    }> => {
        const zip = await JSZip.loadAsync(buffer)
        const metaData = Xml.parse(asDefined(await zip.file("metadata.xml")
            ?.async("string"), "No metadata.xml found"), MetaDataSchema)
        const projectXml = asDefined(await zip.file("project.xml")
            ?.async("string"), "No project.xml found")
        console.debug(projectXml)
        const project = Xml.parse(projectXml, ProjectSchema)
        const resourceFiles = Object.entries(zip.files).filter(([_, file]) =>
            !file.dir && !file.name.endsWith(".xml"))
        const resources: ReadonlyArray<Resource> =
            await Promise.all(resourceFiles.map(async ([path, file]) => {
                const name = path.substring(path.lastIndexOf("/") + 1)
                const buffer = await file.async("arraybuffer")
                const uuid = await UUID.sha256(new Uint8Array(buffer).buffer)
                return {uuid, path, name, buffer}
            }))
        return {
            metaData, project, resources: {
                fromPath: (path: string): Resource => resources
                    .find(resource => resource.path === path) ?? panic("Resource not found"),
                fromUUID: (uuid: UUID.Format): Resource => resources
                    .find(resource => UUID.equals(resource.uuid, uuid)) ?? panic("Resource not found")
            }
        }
    }
}