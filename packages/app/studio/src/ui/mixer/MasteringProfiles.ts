import {Option} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Workers} from "@opendaw/studio-core"
import {Matchering} from "@opendaw/studio-matchering"

// reference profiles saved from analysed audio files: only the analysis (loudness and spectra), never the audio
export namespace MasteringProfiles {
    export type Entry = { name: string, profile: Matchering.ReferenceProfile }

    type Stored = { version: 1, name: string, values: ReadonlyArray<number> }

    const Folder = "mastering-profiles"

    const pathOf = (name: string): string => `${Folder}/${encodeURIComponent(name)}.json`

    export const list = async (): Promise<ReadonlyArray<Entry>> => {
        const entries = await Promises.tryCatch(Workers.Opfs.list(Folder))
        if (entries.status === "rejected") {return []}
        const loaded = await Promise.all(entries.value
            .filter(({kind, name}) => kind === "file" && name.endsWith(".json"))
            .map(async ({name}) => {
                const result = await Promises.tryCatch(Workers.Opfs.read(`${Folder}/${name}`))
                if (result.status === "rejected") {return Option.None}
                const stored: Stored = JSON.parse(new TextDecoder().decode(result.value))
                return Option.wrap({name: stored.name, profile: Matchering.decodeProfile(Float64Array.from(stored.values))})
            }))
        return loaded.flatMap(entry => entry.match({none: () => [], some: value => [value]}))
            .toSorted((a, b) => a.name.localeCompare(b.name))
    }

    export const save = (name: string, profile: Matchering.ReferenceProfile): Promise<void> => {
        const stored: Stored = {version: 1, name, values: Array.from(Matchering.encodeProfile(profile))}
        return Workers.Opfs.write(pathOf(name), new TextEncoder().encode(JSON.stringify(stored)))
    }

    export const remove = (name: string): Promise<void> => Workers.Opfs.delete(pathOf(name))
}
