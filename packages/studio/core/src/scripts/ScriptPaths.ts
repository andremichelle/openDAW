import {UUID} from "@opendaw/lib-std"

export namespace ScriptPaths {
    export const Folder = "scripts/v1"
    export const TrashFile = `${Folder}/trash.json`
    export const ScriptFile = "script.ts"
    export const ScriptMetaFile = "meta.json"
    export const scriptFile = (uuid: UUID.Bytes): string => `${scriptFolder(uuid)}/${ScriptFile}`
    export const scriptMeta = (uuid: UUID.Bytes): string => `${scriptFolder(uuid)}/${ScriptMetaFile}`
    export const scriptFolder = (uuid: UUID.Bytes): string => `${Folder}/${UUID.toString(uuid)}`
}
