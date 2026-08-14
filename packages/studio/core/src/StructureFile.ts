import {z} from "zod"
import {Option, tryCatch, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Workers} from "./Workers"

export type ResourceStructureFolder = {
    readonly name: string
    readonly folders?: ReadonlyArray<ResourceStructureFolder>
    readonly uuids?: ReadonlyArray<UUID.String>
}

export type ResourceTrashEntry = {
    readonly uuid: UUID.String
    readonly path: string
}

export type ResourceStructure = {
    readonly version: 1
    readonly updatedAt?: string
    readonly folders: ReadonlyArray<ResourceStructureFolder>
    readonly trash: ReadonlyArray<ResourceTrashEntry>
}

const FolderSchema: z.ZodType<ResourceStructureFolder> = z.lazy(() => z.object({
    name: z.string(),
    folders: z.array(FolderSchema).optional(),
    uuids: z.array(UUID.zType(z)).optional()
}))

const StructureSchema = z.object({
    version: z.literal(1),
    updatedAt: z.string().optional(),
    folders: z.array(FolderSchema),
    trash: z.array(z.object({uuid: UUID.zType(z), path: z.string()}))
})

// Folder structure for locally stored resources, one file next to the item directories. It holds folder names
// and uuid membership, never metadata: what a row displays still comes from the item's own meta.json, so
// editing an item cannot desynchronise the tree. Anything on disk this file does not mention belongs to the
// root, which is why an import needs no write here and a file deleted elsewhere cannot leave a hole.
export class StructureFile {
    static readonly FileName = "structure.json"
    static readonly Empty: ResourceStructure = {version: 1, folders: [], trash: []}

    readonly #path: string

    constructor(folder: string) {this.#path = `${folder}/${StructureFile.FileName}`}

    // `None` for missing, unreadable or unparsable, which the browser renders as the flat list it showed
    // before folders existed. A broken structure must never cost anyone access to their samples.
    async load(): Promise<Option<ResourceStructure>> {
        const {status, value} = await Promises.tryCatch(Workers.Opfs.read(this.#path))
        if (status === "rejected") {return Option.None}
        const decoded = tryCatch(() => JSON.parse(new TextDecoder().decode(value)))
        if (decoded.status === "failure") {
            console.warn(`'${this.#path}' is not readable json. Ignoring it.`, decoded.error)
            return Option.None
        }
        const parsed = StructureSchema.safeParse(decoded.value)
        if (!parsed.success) {
            console.warn(`'${this.#path}' is not a valid structure. Ignoring it.`, parsed.error)
            return Option.None
        }
        return Option.wrap(parsed.data)
    }

    async save(structure: ResourceStructure): Promise<void> {
        const json = JSON.stringify({...structure, updatedAt: new Date().toISOString()})
        return Workers.Opfs.write(this.#path, new TextEncoder().encode(json))
    }
}
