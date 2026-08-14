import {Arrays, Errors, Option, panic, Procedure, tryCatch, UUID} from "@opendaw/lib-std"
import {ResourceStructure, ResourceStructureFolder, StructureFile} from "../StructureFile"
import {CloudHandler} from "./CloudHandler"

// The folder tree travels with the files, the trash does not: a trashed item is one this device is done with,
// and pushing that decision to every other device is not what a backup is for.
export namespace CloudBackupStructure {
    export const FileName = "structure.json"

    export const trashedUuids = (structure: Option<ResourceStructure>): ReadonlySet<UUID.String> =>
        new Set(structure.mapOr(({trash}) => trash.map(({uuid}) => uuid), Arrays.empty<UUID.String>()))

    export const sync = async (cloudHandler: CloudHandler,
                               file: StructureFile,
                               remotePath: string,
                               log: Procedure<string>): Promise<void> => {
        const path = `${remotePath}/${FileName}`
        const local = (await file.load()).unwrapOrElse(StructureFile.Empty)
        const published: ResourceStructure = {...local, trash: []}
        const remote = await cloudHandler.download(path)
            .then(bytes => parse(bytes))
            .catch(reason => reason instanceof Errors.FileNotFound ? Option.None : panic(reason))
        const merged = remote.mapOr(structure => merge(local, structure), local)
        if (remote.nonEmpty()) {
            log("Merging folder structure...")
            await file.save(merged)
        }
        log("Uploading folder structure...")
        return cloudHandler.upload(path, new TextEncoder()
            .encode(JSON.stringify({...published, folders: merged.folders})).buffer as ArrayBuffer)
    }

    const parse = (bytes: ArrayBuffer): Option<ResourceStructure> => {
        const result = tryCatch(() => JSON.parse(new TextDecoder().decode(bytes)) as ResourceStructure)
        return result.status === "success" ? Option.wrap(result.value) : Option.None
    }

    // Where an item sits locally wins, so filing done here is never overwritten by another device. Anything
    // the local tree does not mention takes the remote folder, and folders themselves are unioned so an empty
    // one still crosses over.
    const merge = (local: ResourceStructure, remote: ResourceStructure): ResourceStructure => {
        const known = new Set<UUID.String>()
        const collect = (folders: ReadonlyArray<ResourceStructureFolder>): void => folders.forEach(folder => {
            folder.uuids?.forEach(uuid => known.add(uuid))
            collect(folder.folders ?? Arrays.empty())
        })
        collect(local.folders)
        local.trash.forEach(({uuid}) => known.add(uuid))
        const mergeInto = (into: ReadonlyArray<ResourceStructureFolder>,
                           from: ReadonlyArray<ResourceStructureFolder>): ReadonlyArray<ResourceStructureFolder> => {
            const result = into.slice()
            from.forEach(folder => {
                const uuids = (folder.uuids ?? []).filter(uuid => !known.has(uuid))
                const index = result.findIndex(({name}) => name.toLowerCase() === folder.name.toLowerCase())
                const target = index < 0 ? {name: folder.name} : result[index]
                const updated: ResourceStructureFolder = {
                    ...target,
                    folders: mergeInto(target.folders ?? Arrays.empty(), folder.folders ?? Arrays.empty()),
                    uuids: [...(target.uuids ?? []), ...uuids]
                }
                if (index < 0) {result.push(updated)} else {result[index] = updated}
            })
            return result
        }
        return {...local, folders: mergeInto(local.folders, remote.folders)}
    }
}
