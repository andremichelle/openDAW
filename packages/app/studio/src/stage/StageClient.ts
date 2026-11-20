import {int, isDefined, Option, Procedure, tryCatch, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace StageClient {
    export type Credentials = Readonly<{ url: string, token: string }>
    export type FileName = "meta.json" | "cover" | "mixdown.opus" | "peaks.bin" | "project.odb"
    export type Alive = Readonly<{ version: int, title: string }>
    export type Published = Readonly<{ slug: string, url: string, updated: int, replaced: boolean }>
    export type Status = Readonly<{ published: boolean, slug?: string, url?: string, updated?: int }>

    type Reply = Readonly<{ error?: string, file?: string }>

    export class Failure extends Error {
        readonly status: int

        constructor(message: string, status: int) {
            super(message)
            this.status = status
        }
    }

    export const Version = 1
    const StorageKey = "stage"
    const ChunkSize = 1 << 20
    const ChunksInFlight = 4
    const MaxBytes = 1 << 30

    const isCredentials = (value: unknown): value is Credentials =>
        typeof value === "object" && isDefined(value)
        && typeof Reflect.get(value, "url") === "string" && typeof Reflect.get(value, "token") === "string"

    export const read = (): Option<Credentials> => {
        const result = tryCatch(() => JSON.parse(localStorage.getItem(StorageKey) ?? "null") as unknown)
        return result.status === "success" && isCredentials(result.value) ? Option.wrap(result.value) : Option.None
    }

    export const write = (credentials: Credentials): void => {
        tryCatch(() => localStorage.setItem(StorageKey, JSON.stringify(credentials)))
    }

    export const forget = (): void => {tryCatch(() => localStorage.removeItem(StorageKey))}

    export const normalizeUrl = (value: string): Option<string> => {
        const result = tryCatch(() => new URL(value.trim()))
        if (result.status === "failure") {return Option.None}
        const url = result.value
        const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
        if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {return Option.None}
        url.pathname = url.pathname.replace(/[^/]*\.php$/, "").replace(/\/*$/, "/")
        url.search = ""
        url.hash = ""
        return Option.wrap(url.toString())
    }

    const messageOf = (status: int, reply: Reply): string => {
        switch (status) {
            case 0:
                return "Could not reach your stage. Check the address and your connection."
            case 401:
                return "Your stage rejected the token."
            case 403:
                return reply.error === "https"
                    ? "Your stage needs HTTPS."
                    : "Your stage refused this openDAW address."
            case 413:
                return "A file is larger than your stage accepts."
            case 422:
                return reply.error === "missing"
                    ? `Your stage is missing the file ${reply.file ?? ""}.`
                    : `Your stage refused the ${reply.error ?? "upload"}.`
            case 503:
                return "Your stage is not set up yet. Open setup.php on your site first."
            case 507:
                return "Your stage is out of storage space."
            default:
                return `Your stage answered with an unexpected error (${status}).`
        }
    }

    const isRetryable = (error: unknown): boolean =>
        error instanceof Failure && (error.status === 0 || (error.status >= 500 && error.status !== 507))

    const request = async <T>(credentials: Credentials, method: "GET" | "POST", action: string,
                              params: Record<string, string>, body?: ArrayBuffer): Promise<T> => {
        const url = new URL("api.php", credentials.url)
        url.searchParams.set("action", action)
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
        const response = await Promises.tryCatch(fetch(url, {
            method, body, cache: "no-store", headers: {"X-OpenDAW-Token": credentials.token}
        }))
        if (response.status === "rejected") {throw new Failure(messageOf(0, {}), 0)}
        const json = await Promises.tryCatch(response.value.json())
        const reply = json.status === "resolved" && isDefined(json.value) ? json.value : {}
        if (!response.value.ok) {throw new Failure(messageOf(response.value.status, reply), response.value.status)}
        return reply as T
    }

    const withRetry = <T>(call: () => Promise<T>): Promise<T> =>
        Promises.guardedRetry(call, (error, count) => isRetryable(error) && count < 4)

    export const alive = (credentials: Credentials): Promise<Alive> =>
        request<Alive>(credentials, "GET", "alive", {})

    export const status = (credentials: Credentials, track: string): Promise<Status> =>
        request<Status>(credentials, "GET", "status", {track})

    export const begin = (credentials: Credentials, track: string): Promise<void> =>
        withRetry(() => request<void>(credentials, "POST", "begin", {track}))

    export const publish = (credentials: Credentials, track: string): Promise<Published> =>
        withRetry(() => request<Published>(credentials, "POST", "publish", {track}))

    export const sendFile = async (credentials: Credentials, track: string, file: FileName, bytes: ArrayBuffer,
                                   sent: Procedure<int>): Promise<void> => {
        if (bytes.byteLength > MaxBytes) {throw new Failure(messageOf(413, {}), 413)}
        if (bytes.byteLength <= ChunkSize) {
            await withRetry(() => request<void>(credentials, "POST", "upload", {track, file}, bytes))
            return sent(bytes.byteLength)
        }
        const session = UUID.toString(UUID.generate())
        const count = Math.ceil(bytes.byteLength / ChunkSize)
        let next = 0
        const worker = async (): Promise<void> => {
            while (next < count) {
                const index = next++
                const chunk = bytes.slice(index * ChunkSize, (index + 1) * ChunkSize)
                await withRetry(() => request<void>(credentials, "POST", "chunk",
                    {session, index: String(index)}, chunk))
                sent(chunk.byteLength)
            }
        }
        await Promise.all(Array.from({length: Math.min(ChunksInFlight, count)}, () => worker()))
        await withRetry(() => request<void>(credentials, "POST", "commit",
            {track, file, session, count: String(count), size: String(bytes.byteLength)}))
    }
}
