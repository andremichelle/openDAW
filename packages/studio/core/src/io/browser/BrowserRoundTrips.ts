import {Exec, Notifier, Option, Subscription, tryCatch} from "@opendaw/lib-std"
import {RoundTrip} from "../RoundTrip"

// measured round trips per output and input device, kept in this browser like the device names they are keyed by
export namespace BrowserRoundTrips {
    const Key = "opendaw:round-trips"
    const notifier = new Notifier<void>()

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

    const store = (entries: ReadonlyArray<RoundTrip.Entry>): void => {
        tryCatch(() => localStorage.setItem(Key, JSON.stringify(entries)))
        notifier.notify()
    }

    const others = (output: string, input: string, sampleRate: number): ReadonlyArray<RoundTrip.Entry> =>
        all().filter(entry => !(entry.output === output && entry.input === input && entry.sampleRate === sampleRate))

    export const save = (entry: RoundTrip.Entry): void =>
        store([...others(entry.output, entry.input, entry.sampleRate), entry])

    export const remove = (output: string, input: string, sampleRate: number): void => {
        if (find(output, input, sampleRate).isEmpty()) {return}
        store(others(output, input, sampleRate))
    }

    export const subscribe = (observer: Exec): Subscription => notifier.subscribe(observer)
}
