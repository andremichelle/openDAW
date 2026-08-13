import {z} from "zod"
import {Sample} from "@opendaw/studio-adapters"

// The folder tree published to assets.opendaw.studio/samples/index.json. It is the only source of structure:
// nothing here invents a folder, the studio renders whatever the file contains. Records carry the full sample
// metadata minus `origin`, which is implied for every cloud sample and injected on the way in.
export type SampleIndexEntry = Omit<Sample, "origin">

export type SampleIndexFolder = {
    readonly name: string
    readonly folders?: ReadonlyArray<SampleIndexFolder>
    readonly samples?: ReadonlyArray<SampleIndexEntry>
}

export type SampleIndex = {
    readonly version: 1
    readonly updatedAt?: string
    readonly folders: ReadonlyArray<SampleIndexFolder>
}

export namespace SampleIndex {
    const Entry = Sample.omit({origin: true})

    export const folderSchema: z.ZodType<SampleIndexFolder> = z.lazy(() => z.object({
        name: z.string().min(1),
        folders: z.array(folderSchema).optional(),
        samples: z.array(Entry).optional()
    }))

    export const schema: z.ZodType<SampleIndex> = z.object({
        version: z.literal(1),
        updatedAt: z.string().optional(),
        folders: z.array(folderSchema)
    })

    export const asSample = (entry: SampleIndexEntry): Sample => ({...entry, origin: "openDAW"})

    export const flatten = (index: SampleIndex): ReadonlyArray<Sample> => {
        const samples: Array<Sample> = []
        const collect = (folder: SampleIndexFolder): void => {
            folder.samples?.forEach(entry => samples.push(asSample(entry)))
            folder.folders?.forEach(collect)
        }
        index.folders.forEach(collect)
        return samples
    }
}
