import {Arrays, Func, int, isDefined, StringComparator, UUID} from "@opendaw/lib-std"
import {ResourceStructure, ResourceStructureFolder, ResourceTrashEntry, StructureFile} from "@opendaw/studio-core"
import {ResourceFolder} from "@/ui/browse/ResourceFolder"

export class LocalTree<T> {
    static readonly TrashName = "Trash"

    static async load<T>(file: StructureFile, uuidOf: Func<T, UUID.String>): Promise<LocalTree<T>> {
        return new LocalTree<T>(file, (await file.load()).unwrapOrElse(StructureFile.Empty), uuidOf)
    }

    static path(parent: string, name: string): string {return parent.length === 0 ? name : `${parent}/${name}`}

    static parentOf(path: string): string {
        const index = path.lastIndexOf("/")
        return index < 0 ? "" : path.slice(0, index)
    }

    static nameOf(path: string): string {
        const index = path.lastIndexOf("/")
        return index < 0 ? path : path.slice(index + 1)
    }

    readonly #file: StructureFile
    readonly #uuidOf: Func<T, UUID.String>

    #structure: ResourceStructure

    private constructor(file: StructureFile, structure: ResourceStructure, uuidOf: Func<T, UUID.String>) {
        this.#file = file
        this.#structure = structure
        this.#uuidOf = uuidOf
    }

    get folders(): ReadonlyArray<ResourceStructureFolder> {return this.#structure.folders}
    get uuidOf(): Func<T, UUID.String> {return this.#uuidOf}

    assemble(items: ReadonlyArray<T>, nameOf: Func<T, string>): ResourceFolder<T> {
        const byUuid = new Map<UUID.String, T>(items.map(item => [this.#uuidOf(item), item]))
        const claimed = new Set<UUID.String>()
        const trashed = new Set<UUID.String>(this.#structure.trash.map(({uuid}) => uuid))
        trashed.forEach(uuid => claimed.add(uuid))
        const sort = (resolved: Array<T>): ReadonlyArray<T> =>
            resolved.toSorted((a, b) => StringComparator(nameOf(a).toLowerCase(), nameOf(b).toLowerCase()))
        const resolve = (uuids: ReadonlyArray<UUID.String>): ReadonlyArray<T> => {
            const resolved: Array<T> = []
            uuids.forEach(uuid => {
                if (claimed.has(uuid)) {return}
                const item = byUuid.get(uuid)
                if (!isDefined(item)) {return}
                claimed.add(uuid)
                resolved.push(item)
            })
            return sort(resolved)
        }
        const build = (folder: ResourceStructureFolder): ResourceFolder<T> => ({
            name: folder.name,
            folders: folder.folders?.map(build) ?? [],
            items: resolve(folder.uuids ?? [])
        })
        const folders = this.#structure.folders.map(build)
        const trash = sort(this.#structure.trash
            .map(({uuid}) => byUuid.get(uuid))
            .filter(isDefined))
        return {
            name: "",
            folders: [...folders, {name: LocalTree.TrashName, folders: [], items: trash}],
            items: sort(items.filter(item => !claimed.has(this.#uuidOf(item))))
        }
    }

    isTrashed(uuid: UUID.String): boolean {
        return this.#structure.trash.some(entry => entry.uuid === uuid)
    }

    async trash(uuids: ReadonlyArray<UUID.String>): Promise<void> {
        const trashing = uuids.filter(uuid => !this.isTrashed(uuid))
        if (trashing.length === 0) {return}
        const entries = trashing.map(uuid => ({uuid, path: this.pathOf(uuid)}))
        const remove = new Set(trashing)
        const strip = (folder: ResourceStructureFolder): ResourceStructureFolder => ({
            ...folder,
            folders: folder.folders?.map(strip),
            uuids: folder.uuids?.filter(uuid => !remove.has(uuid))
        })
        this.#structure = {
            ...this.#structure,
            folders: this.#structure.folders.map(strip),
            trash: [...this.#structure.trash, ...entries]
        }
        return this.#file.save(this.#structure)
    }

    // The folder goes with everything under it, and each item remembers its own path, so putting one back
    // recreates the folder it came from.
    async trashFolder(path: string): Promise<void> {
        const collect = (node: LocalTree.Node, at: string): ReadonlyArray<ResourceTrashEntry> => [
            ...node.uuids.map(uuid => ({uuid, path: at})),
            ...node.folders.flatMap(sub => collect({
                folders: sub.folders ?? Arrays.empty(),
                uuids: sub.uuids ?? Arrays.empty()
            }, LocalTree.path(at, sub.name)))
        ]
        const entries = collect(this.#node(path), path).filter(({uuid}) => !this.isTrashed(uuid))
        const name = LocalTree.nameOf(path)
        await this.#write(LocalTree.parentOf(path), node => ({
            ...node,
            folders: node.folders.filter(folder => folder.name !== name)
        }))
        this.#structure = {...this.#structure, trash: [...this.#structure.trash, ...entries]}
        return this.#file.save(this.#structure)
    }

    async restore(uuids: ReadonlyArray<UUID.String>): Promise<void> {
        const restoring = this.#structure.trash.filter(entry => uuids.includes(entry.uuid))
        if (restoring.length === 0) {return}
        this.#structure = {
            ...this.#structure,
            trash: this.#structure.trash.filter(entry => !uuids.includes(entry.uuid))
        }
        for (const {uuid, path} of restoring) {
            this.#ensureFolder(path)
            await this.move([uuid], path)
        }
    }

    async forget(uuids: ReadonlyArray<UUID.String>): Promise<void> {
        if (uuids.length === 0) {return}
        const gone = new Set(uuids)
        const strip = (folder: ResourceStructureFolder): ResourceStructureFolder => ({
            ...folder,
            folders: folder.folders?.map(strip),
            uuids: folder.uuids?.filter(uuid => !gone.has(uuid))
        })
        this.#structure = {
            ...this.#structure,
            folders: this.#structure.folders.map(strip),
            trash: this.#structure.trash.filter(entry => !gone.has(entry.uuid))
        }
        return this.#file.save(this.#structure)
    }

    #ensureFolder(path: string): void {
        const names = path.split("/").filter(name => name.length > 0)
        let folders: ReadonlyArray<ResourceStructureFolder> = this.#structure.folders
        let parentPath = ""
        for (const name of names) {
            if (!folders.some(folder => folder.name === name)) {
                this.#structure = {
                    ...this.#structure,
                    folders: LocalTree.#insertFolder(this.#structure.folders,
                        parentPath.split("/").filter(part => part.length > 0), 0, name)
                }
            }
            parentPath = LocalTree.path(parentPath, name)
            folders = this.#node(parentPath).folders
        }
    }

    static #insertFolder(folders: ReadonlyArray<ResourceStructureFolder>,
                         names: ReadonlyArray<string>,
                         depth: int,
                         name: string): ReadonlyArray<ResourceStructureFolder> {
        if (depth === names.length) {return [...folders, {name}]}
        return folders.map(folder => folder.name !== names[depth]
            ? folder
            : {
                ...folder,
                folders: LocalTree.#insertFolder(folder.folders ?? Arrays.empty(), names, depth + 1, name)
            })
    }

    pathOf(uuid: UUID.String): string {
        const search = (folders: ReadonlyArray<ResourceStructureFolder>, path: string): string => {
            for (const folder of folders) {
                const folderPath = LocalTree.path(path, folder.name)
                if (folder.uuids?.includes(uuid) === true) {return folderPath}
                const found = search(folder.folders ?? Arrays.empty(), folderPath)
                if (found.length > 0) {return found}
            }
            return ""
        }
        return search(this.#structure.folders, "")
    }

    // The root is the empty path and has no entry of its own: not being named anywhere IS being at the root.
    async move(uuids: ReadonlyArray<UUID.String>, path: string): Promise<void> {
        if (uuids.length === 0) {return}
        const moving = new Set(uuids)
        const strip = (folder: ResourceStructureFolder): ResourceStructureFolder => ({
            ...folder,
            folders: folder.folders?.map(strip),
            uuids: folder.uuids?.filter(uuid => !moving.has(uuid))
        })
        const names = path.split("/").filter(name => name.length > 0)
        const insert = (folders: ReadonlyArray<ResourceStructureFolder>,
                        depth: int): ReadonlyArray<ResourceStructureFolder> =>
            folders.map(folder => folder.name !== names[depth]
                ? folder
                : depth === names.length - 1
                    ? {...folder, uuids: [...(folder.uuids ?? []), ...uuids]}
                    : {...folder, folders: insert(folder.folders ?? [], depth + 1)})
        const stripped = this.#structure.folders.map(strip)
        this.#structure = {
            ...this.#structure,
            folders: names.length === 0 ? stripped : insert(stripped, 0),
            trash: this.#structure.trash.filter(entry => !moving.has(entry.uuid))
        }
        return this.#file.save(this.#structure)
    }

    async createFolder(parentPath: string, name: string): Promise<string> {
        const unique = this.uniqueName(parentPath, name)
        await this.#write(parentPath, node => ({...node, folders: [...node.folders, {name: unique}]}))
        return unique
    }

    async renameFolder(path: string, name: string): Promise<void> {
        const parentPath = LocalTree.parentOf(path)
        const current = LocalTree.nameOf(path)
        if (name === current) {return}
        const unique = this.uniqueName(parentPath, name)
        return this.#write(parentPath, node => ({
            ...node,
            folders: node.folders.map(folder => folder.name === current ? {...folder, name: unique} : folder)
        }))
    }

    uniqueName(parentPath: string, candidate: string): string {
        const taken = new Set(this.#node(parentPath).folders.map(folder => folder.name.toLowerCase()))
        if (parentPath.length === 0) {taken.add(LocalTree.TrashName.toLowerCase())}
        return LocalTree.#unique(taken, candidate)
    }

    static #unique(taken: ReadonlySet<string>, candidate: string): string {
        if (!taken.has(candidate.toLowerCase())) {return candidate}
        for (let index = 2; ; index++) {
            const name = `${candidate} ${index}`
            if (!taken.has(name.toLowerCase())) {return name}
        }
    }

    #node(path: string): LocalTree.Node {
        const names = path.split("/").filter(name => name.length > 0)
        let folders: ReadonlyArray<ResourceStructureFolder> = this.#structure.folders
        let uuids: ReadonlyArray<UUID.String> = Arrays.empty()
        for (const name of names) {
            const folder = folders.find(candidate => candidate.name === name)
            if (!isDefined(folder)) {return {folders: Arrays.empty(), uuids: Arrays.empty()}}
            folders = folder.folders ?? Arrays.empty()
            uuids = folder.uuids ?? Arrays.empty()
        }
        return {folders, uuids}
    }

    async #write(path: string, mutate: Func<LocalTree.Node, LocalTree.Node>): Promise<void> {
        const names = path.split("/").filter(name => name.length > 0)
        const descend = (folders: ReadonlyArray<ResourceStructureFolder>,
                         depth: int): ReadonlyArray<ResourceStructureFolder> =>
            folders.map(folder => {
                if (folder.name !== names[depth]) {return folder}
                if (depth < names.length - 1) {
                    return {...folder, folders: descend(folder.folders ?? Arrays.empty(), depth + 1)}
                }
                const {folders: sub, uuids} = mutate({
                    folders: folder.folders ?? Arrays.empty(),
                    uuids: folder.uuids ?? Arrays.empty()
                })
                return {...folder, folders: sub, uuids}
            })
        this.#structure = {
            ...this.#structure,
            folders: names.length === 0
                ? mutate({folders: this.#structure.folders, uuids: Arrays.empty()}).folders
                : descend(this.#structure.folders, 0)
        }
        return this.#file.save(this.#structure)
    }
}

export namespace LocalTree {
    export type Node = {
        readonly folders: ReadonlyArray<ResourceStructureFolder>
        readonly uuids: ReadonlyArray<UUID.String>
    }
}
