import {z} from "zod"
import {Soundfont} from "@opendaw/studio-adapters"

// The folder tree published to assets.opendaw.studio/soundfonts/index.json. Same contract as SampleIndex:
// the file is the only source of structure, and `origin` is implied for every published soundfont.
export type SoundfontIndexEntry = Omit<Soundfont, "origin">

export type SoundfontIndexFolder = {
    readonly name: string
    readonly folders?: ReadonlyArray<SoundfontIndexFolder>
    readonly soundfonts?: ReadonlyArray<SoundfontIndexEntry>
}

export type SoundfontIndex = {
    readonly version: 1
    readonly updatedAt?: string
    readonly folders: ReadonlyArray<SoundfontIndexFolder>
}

export namespace SoundfontIndex {
    const Entry = Soundfont.omit({origin: true})

    export const folderSchema: z.ZodType<SoundfontIndexFolder> = z.lazy(() => z.object({
        name: z.string().min(1),
        folders: z.array(folderSchema).optional(),
        soundfonts: z.array(Entry).optional()
    }))

    export const schema: z.ZodType<SoundfontIndex> = z.object({
        version: z.literal(1),
        updatedAt: z.string().optional(),
        folders: z.array(folderSchema)
    })

    export const asSoundfont = (entry: SoundfontIndexEntry): Soundfont => ({...entry, origin: "openDAW"})

    export const flatten = (index: SoundfontIndex): ReadonlyArray<Soundfont> => {
        const soundfonts: Array<Soundfont> = []
        const collect = (folder: SoundfontIndexFolder): void => {
            folder.soundfonts?.forEach(entry => soundfonts.push(asSoundfont(entry)))
            folder.folders?.forEach(collect)
        }
        index.folders.forEach(collect)
        return soundfonts
    }
}
