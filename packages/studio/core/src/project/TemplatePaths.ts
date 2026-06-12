import {UUID} from "@opendaw/lib-std"

export namespace TemplatePaths {
    export const Folder = "templates/v1"
    export const ProjectFile = "project.od"
    export const ProjectMetaFile = "meta.json"
    export const ProjectCoverFile = "image.bin"
    export const projectFile = (uuid: UUID.Bytes): string => `${(templateFolder(uuid))}/${ProjectFile}`
    export const projectMeta = (uuid: UUID.Bytes): string => `${(templateFolder(uuid))}/${ProjectMetaFile}`
    export const projectCover = (uuid: UUID.Bytes): string => `${(templateFolder(uuid))}/${ProjectCoverFile}`
    export const templateFolder = (uuid: UUID.Bytes): string => `${Folder}/${UUID.toString(uuid)}`
}
