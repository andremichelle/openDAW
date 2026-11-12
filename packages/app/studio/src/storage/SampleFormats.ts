import {int, isAbsent, isDefined, Nullable, Procedure, tryCatch, unitValue} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {StorageWalk} from "@opendaw/lib-fusion"
import {SampleConversion, WavFile} from "@opendaw/lib-dsp"

// Which stored samples are 16 bit, which could become it and what that frees.
export namespace SampleFormats {
    export type Entry = {
        readonly id: string
        readonly name: string
        readonly origin: Nullable<string>
        readonly size: int
        readonly kind: SampleConversion.Kind
        // unknown for a sample that is 16 bit already, its frames are not read
        readonly peak: Nullable<number>
        readonly saving: int
        // a replacement of the audio file was cut off
        readonly pending: boolean
    }
    export type Report = { readonly entries: ReadonlyArray<Entry>, readonly failures: ReadonlyArray<string> }
    export type Reader = (path: string) => Promise<Uint8Array>
    export type HeadReader = (path: string, bytes: int) => Promise<Uint8Array>

    // duplicated from SampleStorage, which this worker does not load
    export const Folder = "samples/v2/"
    const Leftovers: ReadonlyArray<string> = ["audio.wav.pending", "audio.wav.commit"]
    const HeadBytes = 44

    export const KindOrder: ReadonlyArray<SampleConversion.Kind> = ["exact", "rounding", "scaling", "float", "sixteen"]

    const metaOf = async (read: Reader, path: string): Promise<{ name: Nullable<string>, origin: Nullable<string> }> => {
        const bytes = await Promises.tryCatch(read(path))
        if (bytes.status === "rejected") {return {name: null, origin: null}}
        const parsed = tryCatch(() => JSON.parse(new TextDecoder().decode(bytes.value)))
        if (parsed.status === "failure" || typeof parsed.value !== "object" || isAbsent(parsed.value)) {return {name: null, origin: null}}
        const {name, origin} = parsed.value
        return {name: typeof name === "string" ? name : null, origin: typeof origin === "string" ? origin : null}
    }

    export const scan = async (files: ReadonlyArray<StorageWalk.File>, head: HeadReader, read: Reader,
                               progress: Procedure<unitValue>): Promise<Report> => {
        const audio = files.filter(({path}) => path.startsWith(Folder) && path.endsWith("/audio.wav")
            && path.split("/").length === 4)
        const pending = new Set(files.filter(({path}) => path.startsWith(Folder)
            && Leftovers.some(name => path.endsWith(`/${name}`))).map(({path}) => path.split("/")[2]))
        const entries: Array<Entry> = []
        const failures: Array<string> = []
        for (const [index, {path, size}] of audio.entries()) {
            const id = path.split("/")[2]
            const folder = `${Folder}${id}`
            const {name, origin} = await metaOf(read, `${folder}/meta.json`)
            const base = {id, name: name ?? id, origin, size, pending: pending.has(id)}
            const start = await Promises.tryCatch(head(path, HeadBytes))
            if (start.status === "resolved" && WavFile.isSixteenBit(start.value)) {
                entries.push({...base, kind: "sixteen", peak: null, saving: 0})
            } else {
                const bytes = await Promises.tryCatch(read(path))
                const decoded = bytes.status === "rejected" ? undefined : tryCatch(() => WavFile.decodePcm(
                    bytes.value.buffer.slice(bytes.value.byteOffset, bytes.value.byteOffset + bytes.value.byteLength) as ArrayBuffer))
                if (!isDefined(decoded) || decoded.status === "failure") {
                    failures.push(path)
                } else {
                    const {kind, peak} = SampleConversion.judge(decoded.value)
                    const saving = SampleConversion.isConvertible(kind)
                        ? Math.max(0, size - SampleConversion.bytesAfter(decoded.value)) : 0
                    entries.push({...base, kind, peak: kind === "sixteen" ? null : peak, saving})
                }
            }
            progress((index + 1) / audio.length)
        }
        return {entries, failures}
    }

    // the entry of a sample after its conversion
    export const converted = (entry: Entry): Entry =>
        ({...entry, kind: "sixteen", peak: null, size: entry.size - entry.saving, saving: 0, pending: false})

    export const ofKind = (entries: ReadonlyArray<Entry>, kind: SampleConversion.Kind): ReadonlyArray<Entry> =>
        entries.filter(entry => entry.kind === kind).toSorted((left, right) => right.size - left.size
            || left.name.localeCompare(right.name))

    export const savingOf = (entries: ReadonlyArray<Entry>): int => entries.reduce((sum, {saving}) => sum + saving, 0)

    export const sizeOf = (entries: ReadonlyArray<Entry>): int => entries.reduce((sum, {size}) => sum + size, 0)

    // how far a sample is lowered before it is rounded, in decibel, zero unless it is above full scale
    export const loweredBy = ({kind, peak}: Entry): number =>
        kind === "scaling" && isDefined(peak) ? -20.0 * Math.log10(SampleConversion.gainOf({kind, peak})) : 0.0

    export const describe = (entry: Entry): string => {
        switch (entry.kind) {
            case "sixteen":
                return "Is 16 bit"
            case "exact":
                return "Nothing is lost"
            case "rounding":
                return "Rounded to 16 bit"
            case "scaling":
                return `Lowered by ${loweredBy(entry).toFixed(2)} dB, then rounded`
            case "float":
                return "Too loud for 16 bit, stays 32 bit"
        }
    }

    export const peakText = ({peak}: Entry): string => {
        if (!isDefined(peak)) {return ""}
        if (peak === 0.0) {return "silent"}
        if (!Number.isFinite(peak)) {return "not a number"}
        const decibel = 20.0 * Math.log10(peak)
        const text = decibel.toFixed(2)
        return text === "-0.00" || text === "0.00" ? "0.00 dB" : `${decibel > 0.0 ? "+" : ""}${text} dB`
    }
}
