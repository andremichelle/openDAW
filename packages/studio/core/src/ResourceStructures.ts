import {isDefined, UUID} from "@opendaw/lib-std"
import {ResourceStructure, ResourceStructureFolder} from "./StructureFile"

export namespace ResourceStructures {
    const everyUuid = (folders: ReadonlyArray<ResourceStructureFolder>): ReadonlyArray<UUID.String> =>
        folders.flatMap(folder => [...folder.uuids ?? [], ...everyUuid(folder.folders ?? [])])

    // Puts the items into the folder at `path`, creating the folders that are missing. An item that already
    // sits in a folder or in the trash stays where the user has it.
    export const place = (structure: ResourceStructure, path: ReadonlyArray<string>,
                          uuids: ReadonlyArray<UUID.String>): ResourceStructure => {
        const taken = new Set<UUID.String>([...everyUuid(structure.folders), ...structure.trash.map(entry => entry.uuid)])
        const adding = Array.from(new Set(uuids.filter(uuid => !taken.has(uuid))))
        if (path.length === 0 || adding.length === 0) {return structure}
        const into = (folders: ReadonlyArray<ResourceStructureFolder>, [name, ...rest]: ReadonlyArray<string>): ReadonlyArray<ResourceStructureFolder> => {
            const existing = folders.find(folder => folder.name === name)
            const folder: ResourceStructureFolder = existing ?? {name}
            const next: ResourceStructureFolder = rest.length === 0
                ? {...folder, uuids: [...folder.uuids ?? [], ...adding]}
                : {...folder, folders: into(folder.folders ?? [], rest)}
            return isDefined(existing) ? folders.map(other => other === existing ? next : other) : [...folders, next]
        }
        return {...structure, folders: into(structure.folders, path)}
    }
}
