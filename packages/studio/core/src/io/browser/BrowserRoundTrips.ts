import {Option, tryCatch} from "@opendaw/lib-std"
import {RoundTrip} from "../RoundTrip"

// measured round trips per output and input device, kept in this browser like the device names they are keyed by
export namespace BrowserRoundTrips {
    const Key = "opendaw:round-trips"

    const isEntry = (value: unknown): value is RoundTrip.Entry => {
        if (typeof value !== "object" || value === null) {return false}
        const {output, input, sampleRate, seconds, measuredAt} = value as Record<string, unknown>
        return typeof output === "string" && typeof input === "string" && typeof sampleRate === "number"
            && typeof seconds === "number" && Number.isFinite(seconds) && typeof measuredAt === "number"
    }

    export const all = (): ReadonlyArray<RoundTrip.Entry> => {
        const {status, value} = tryCatch(() => JSON.parse(localStorage.getItem(Key) ?? "[]"))
        return status === "success" && Array.isArray(value) ? value.filter(isEntry) : []
    }

    export const find = (output: string, input: string, sampleRate: number): Option<RoundTrip.Entry> =>
        Option.wrap(all().find(entry =>
            entry.output === output && entry.input === input && entry.sampleRate === sampleRate))

    export const save = (entry: RoundTrip.Entry): void => {
        const others = all().filter(({output, input, sampleRate}) =>
            !(output === entry.output && input === entry.input && sampleRate === entry.sampleRate))
        tryCatch(() => localStorage.setItem(Key, JSON.stringify([...others, entry])))
    }
}
