import {isDefined, Nullable, tryCatch} from "@opendaw/lib-std"
import {Shell} from "@/platform/desktop/Shell"

// The studio's console errors, warnings and marked lines go into openDAW.log through the engine, the inspector's
// console cannot be copied everywhere (a Windows VM). Lines before the connection opens are queued.
export namespace DesktopConsole {
    const Marks: ReadonlyArray<string> = ["[boot]", "[wclap trace]"]
    const MaxLength = 2000
    const MaxQueued = 500

    type Level = "error" | "warn" | "info"

    const formatOne = (value: unknown): string => {
        if (value instanceof Error) {return value.stack ?? `${value.name}: ${value.message}`}
        if (typeof value === "string") {return value}
        if (value === undefined || typeof value === "function" || typeof value === "symbol") {return String(value)}
        const {status, value: json} = tryCatch(() => JSON.stringify(value))
        return status === "success" && isDefined(json) ? json : String(value)
    }

    // one line per console call, bounded, line breaks written out
    export const format = (args: ReadonlyArray<unknown>): string =>
        args.map(formatOne).join(" ").replaceAll("\n", "\\n").slice(0, MaxLength)

    const isMarked = (args: ReadonlyArray<unknown>): boolean =>
        typeof args[0] === "string" && Marks.some(mark => (args[0] as string).startsWith(mark))

    export const install = (): void => {
        const {engine} = Shell.info()
        if (!isDefined(engine)) {return}
        const queue: Array<string> = []
        const state: { socket: Nullable<WebSocket> } = {socket: null}
        const send = (level: Level, args: ReadonlyArray<unknown>): void => {
            const line = JSON.stringify({type: "log", level, text: format(args)})
            if (state.socket?.readyState === WebSocket.OPEN) {
                state.socket.send(line)
            } else if (queue.length < MaxQueued) {
                queue.push(line)
            }
        }
        const {error, warn, debug, log, info} = console
        console.error = (...args: Array<unknown>) => {
            error.apply(console, args)
            send("error", args)
        }
        console.warn = (...args: Array<unknown>) => {
            warn.apply(console, args)
            send("warn", args)
        }
        for (const [name, original] of [["debug", debug], ["log", log], ["info", info]] as const) {
            console[name] = (...args: Array<unknown>) => {
                original.apply(console, args)
                if (isMarked(args)) {send("info", args)}
            }
        }
        window.addEventListener("error", event => send("error", ["uncaught", event.error ?? event.message]))
        window.addEventListener("unhandledrejection", event => send("error", ["unhandled rejection", event.reason]))
        const connect = (attempt: number): void => {
            const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/audio?token=${engine.token}`)
            socket.onopen = () => {
                state.socket = socket
                queue.splice(0).forEach(line => socket.send(line))
            }
            socket.onclose = () => {
                state.socket = null
                setTimeout(() => connect(attempt + 1), attempt < 20 ? 250 : 2000)
            }
        }
        connect(0)
    }
}
