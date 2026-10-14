import {z} from "zod"

// The folder tree published to assets.opendaw.studio/wclaps/index.json, same contract as SoundfontIndex
export type WclapIndexPlugin = {
    readonly clapId: string
    readonly name: string
    readonly vendor: string
    readonly features: ReadonlyArray<string>
}

export type WclapIndexEntry = {
    readonly uuid: string
    readonly name: string
    readonly size: number
    readonly url: string
    readonly credits: string
    readonly license: string
    readonly plugins: ReadonlyArray<WclapIndexPlugin>
}

export type WclapIndexFolder = {
    readonly name: string
    readonly folders?: ReadonlyArray<WclapIndexFolder>
    readonly wclaps?: ReadonlyArray<WclapIndexEntry>
}

export type WclapIndex = {
    readonly version: 1
    readonly updatedAt?: string
    readonly folders: ReadonlyArray<WclapIndexFolder>
}

export namespace WclapIndex {
    export const Empty: WclapIndex = {version: 1, folders: []}

    const Plugin = z.object({clapId: z.string(), name: z.string(), vendor: z.string(), features: z.array(z.string())})

    const Entry = z.object({
        uuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        name: z.string(),
        size: z.number(),
        url: z.string(),
        credits: z.string().default(""),
        license: z.string(),
        plugins: z.array(Plugin)
    })

    export const folderSchema: z.ZodType<WclapIndexFolder> = z.lazy(() => z.object({
        name: z.string().min(1),
        folders: z.array(folderSchema).optional(),
        wclaps: z.array(Entry).optional()
    }))

    export const schema: z.ZodType<WclapIndex> = z.object({
        version: z.literal(1),
        updatedAt: z.string().optional(),
        folders: z.array(folderSchema)
    })

    export const flatten = (index: WclapIndex): ReadonlyArray<WclapIndexEntry> => {
        const entries: Array<WclapIndexEntry> = []
        const collect = (folder: WclapIndexFolder): void => {
            folder.wclaps?.forEach(entry => entries.push(entry))
            folder.folders?.forEach(collect)
        }
        index.folders.forEach(collect)
        return entries
    }
}
