import {int} from "@opendaw/lib-std"

export namespace LogBuffer {
    export type Entry = {
        time: number
        level: "debug" | "info" | "warn"
        args: Array<string>
    }

    const logBuffer: Entry[] = []

    if (import.meta.env.PROD) {
        let estimatedSize: int = 0
        const MAX_ARGS_SIZE = 100_000
        const pushLog = (level: Entry["level"], args: unknown[]) => {
            const entry: Entry = {time: Date.now(), level, args: args.map(String)}
            const argLength = entry.args.length
            logBuffer.push(entry)
            estimatedSize += argLength
            while (estimatedSize > MAX_ARGS_SIZE && logBuffer.length > 1) {
                const removed = logBuffer.shift()!
                estimatedSize -= removed.args.length
            }
        }
        const stringifyArg = (value: unknown): string => {
            try {
                // If it's already a primitive
                if (
                    value === null ||
                    typeof value === "string" ||
                    typeof value === "number" ||
                    typeof value === "boolean" ||
                    typeof value === "bigint" ||
                    typeof value === "symbol" ||
                    typeof value === "undefined"
                ) {
                    return String(value)
                }

                // If it has a custom toString implementation
                const protoToString = Object.prototype.toString
                if (
                    typeof value === "object" &&
                    value &&
                    typeof (value as any).toString === "function" &&
                    (value as any).toString !== protoToString
                ) {
                    const result = (value as any).toString()
                    if (typeof result === "string") return result
                }

                if (typeof value === "object") {
                    const maxLength = 4000
                    const json = JSON.stringify(value)
                    return json.length > maxLength ? json.slice(0, maxLength) + "…" : json
                }

                // Last resort fallback
                return Object.prototype.toString.call(value)
            } catch {
                return "[unserializable]"
            }
        }

        const original = {debug: console.debug, info: console.info, warn: console.warn} as const
        console.debug = (...args) => {
            pushLog("debug", args.map(stringifyArg))
            original.debug.apply(console, args)
        }
        console.info = (...args) => {
            pushLog("info", args.map(stringifyArg))
            original.info.apply(console, args)
        }
        console.warn = (...args) => {
            pushLog("warn", args.map(stringifyArg))
            original.warn.apply(console, args)
        }
    }
    export const get = () => logBuffer
}