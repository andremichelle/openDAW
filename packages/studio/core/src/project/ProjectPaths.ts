import {UUID} from "@moises-ai/lib-std"

export namespace ProjectPaths {
    export const Folder = "projects/v1"
    export const ProjectFile = "project.od"
    export const ProjectMetaFile = "meta.json"
    export const ProjectCoverFile = "image.bin"
    export const projectFile = (uuid: UUID.Bytes): string => `${(projectFolder(uuid))}/${ProjectFile}`
    export const projectMeta = (uuid: UUID.Bytes): string => `${(projectFolder(uuid))}/${ProjectMetaFile}`
    export const projectCover = (uuid: UUID.Bytes): string => `${(projectFolder(uuid))}/${ProjectCoverFile}`
    export const projectFolder = (uuid: UUID.Bytes): string => `${Folder}/${UUID.toString(uuid)}`
}