import {int, isDefined, tryCatch} from "@opendaw/lib-std"
import {SpotlightEntry} from "@/ui/spotlight/SpotlightEntry"

const StorageKey = "spotlight-usage"

export namespace SpotlightUsage {
    const keyOf = ({verb, label}: SpotlightEntry): string => `${verb}:${label}`

    const read = (): Record<string, int> => {
        const {status, value} = tryCatch(() => JSON.parse(localStorage.getItem(StorageKey) ?? "{}"))
        return status === "success" && isDefined(value) && typeof value === "object" && !Array.isArray(value) ? value : {}
    }

    export const count = (): (entry: SpotlightEntry) => int => {
        const counts = read()
        return entry => counts[keyOf(entry)] ?? 0
    }

    export const record = (entry: SpotlightEntry): void => {
        const counts = read()
        counts[keyOf(entry)] = (counts[keyOf(entry)] ?? 0) + 1
        tryCatch(() => localStorage.setItem(StorageKey, JSON.stringify(counts)))
    }
}
