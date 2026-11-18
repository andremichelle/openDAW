import {Arrays, Errors, isDefined, Optional, panic, Progress, tryCatch, unitValue} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"

export type CustomServerCredentials = {
    url: string
    token: string
}

export class CustomServerHandler implements CloudHandler {
    static readonly Version = 1
    static readonly ChunkSize = 1024 * 1024
    // hosts throttle each HTTP/2 upload stream, parallel chunks multiply the throughput
    static readonly ParallelChunks = 4
    static readonly MaxAttempts = 4

    static #isTransient(status: number): boolean {return status === 502 || status === 503 || status === 504}

    static #describe(status: number, error: string, operation: string, path: string): string {
        if (status === 401) {return "The server rejected the token."}
        if (status === 403 && error === "origin") {return "The server file does not allow this openDAW address."}
        if (status === 403 && error === "https") {return "The server only answers over HTTPS."}
        if (status === 507) {return "The server could not store the file (disk full or not writable)."}
        if (status === 413) {return `The server rejected the size of '${path}'.`}
        return `Custom server ${operation} failed (${status}${error.length > 0 ? ` ${error}` : ""}) for '${path}'`
    }

    readonly #url: string
    readonly #token: string
    readonly #signal: Optional<AbortSignal>

    constructor({url, token}: CustomServerCredentials, signal?: AbortSignal) {
        this.#url = url.trim()
        this.#token = token.trim()
        this.#signal = signal
    }

    async version(): Promise<number> {
        const response = await this.#request("alive", {})
        if (!response.ok) {return this.#fail(response, "alive", "")}
        const {version} = await response.json() as { version: number }
        return version
    }

    async alive(): Promise<void> {await this.version()}

    async upload(path: string, data: ArrayBuffer, progress?: Progress.Handler): Promise<void> {
        const total = data.byteLength
        if (total <= CustomServerHandler.ChunkSize) {
            await this.#post({action: "upload", path}, data, progress)
            progress?.(1.0)
            return
        }
        const session = crypto.randomUUID()
        const chunkCount = Math.ceil(total / CustomServerHandler.ChunkSize)
        const sent = new Float64Array(chunkCount)
        const report = (index: number, bytes: number) => {
            sent[index] = bytes
            progress?.(sent.reduce((sum, value) => sum + value, 0) / total)
        }
        await Promises.allWithLimit(Arrays.create(index => async () => {
            const start = index * CustomServerHandler.ChunkSize
            const end = Math.min(start + CustomServerHandler.ChunkSize, total)
            await this.#post({action: "chunk", session, index: String(index)}, data.slice(start, end),
                (fraction: unitValue) => report(index, fraction * (end - start)))
            report(index, end - start)
        }, chunkCount), CustomServerHandler.ParallelChunks)
        await this.#post({action: "commit", session, path, count: String(chunkCount), size: String(total)},
            new ArrayBuffer(0))
        progress?.(1.0)
    }

    async download(path: string): Promise<ArrayBuffer> {
        const response = await this.#request("download", {path})
        if (response.status === 404) {return Promise.reject(new Errors.FileNotFound(path))}
        if (!response.ok) {return this.#fail(response, "download", path)}
        return response.arrayBuffer()
    }

    async exists(path: string): Promise<boolean> {
        const response = await this.#request("exists", {path})
        if (!response.ok) {return this.#fail(response, "exists", path)}
        const {exists} = await response.json() as { exists: boolean }
        return exists
    }

    async list(path?: string): Promise<Array<string>> {
        const target = path ?? ""
        const response = await this.#request("list", {path: target})
        if (!response.ok) {return this.#fail(response, "list", target)}
        const {names} = await response.json() as { names: Array<string> }
        return names
    }

    async delete(path: string): Promise<void> {
        const response = await this.#request("delete", {path}, "POST")
        if (!response.ok) {return this.#fail(response, "delete", path)}
    }

    #endpoint(params: Record<string, string>): string {
        const url = new URL(this.#url)
        for (const [key, value] of Object.entries(params)) {url.searchParams.set(key, value)}
        return url.toString()
    }

    async #fail(response: Response, operation: string, path: string): Promise<never> {
        const body = await response.json().then(json => (json as { error?: string }).error ?? "", () => "")
        return panic(CustomServerHandler.#describe(response.status, body, operation, path))
    }

    async #request(action: string, params: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<Response> {
        const url = this.#endpoint({action, ...params})
        const result = await Promises.tryCatch(Promises.guardedRetry(
            () => fetch(url, {method, headers: {"X-OpenDAW-Token": this.#token}, signal: this.#signal, cache: "no-store"})
                .then(response => CustomServerHandler.#isTransient(response.status)
                    ? Promise.reject(new Error(`Custom server transient status ${response.status} for '${url}'`))
                    : response),
            (error, count) => this.#retryable(error, count)))
        if (result.status === "resolved") {return result.value}
        if (this.#aborted()) {return Promise.reject(Errors.AbortError)}
        console.warn(result.error)
        return panic("The server is not reachable. Check the address.")
    }

    #post(params: Record<string, string>, data: ArrayBuffer, progress?: Progress.Handler): Promise<void> {
        const path = params.path ?? ""
        return Promises.guardedRetry(() => this.#postOnce(params, data, progress), (error, count) => this.#retryable(error, count))
            .catch(error => Promise.reject(this.#aborted() ? Errors.AbortError : error))
            .then(({status, error}) => status >= 200 && status < 300
                ? undefined
                : panic(CustomServerHandler.#describe(status, error, params.action, path)))
    }

    #postOnce(params: Record<string, string>, data: ArrayBuffer,
              progress?: Progress.Handler): Promise<{ status: number, error: string }> {
        const {promise, resolve, reject} = Promise.withResolvers<{ status: number, error: string }>()
        const signal = this.#signal
        if (this.#aborted()) {return Promise.reject(Errors.AbortError)}
        const xhr = new XMLHttpRequest()
        const onAbort = () => xhr.abort()
        const cleanup = () => {if (isDefined(signal)) {signal.removeEventListener("abort", onAbort)}}
        xhr.open("POST", this.#endpoint(params))
        xhr.setRequestHeader("X-OpenDAW-Token", this.#token)
        xhr.setRequestHeader("Content-Type", "application/octet-stream")
        if (isDefined(progress)) {
            xhr.upload.onprogress = event => {if (event.lengthComputable) {progress(event.loaded / event.total)}}
        }
        xhr.onload = () => {
            cleanup()
            if (CustomServerHandler.#isTransient(xhr.status)) {
                reject(new Error(`Custom server transient status ${xhr.status} for '${params.action}'`))
                return
            }
            const parsed = tryCatch(() => JSON.parse(xhr.responseText) as { error?: string })
            resolve({status: xhr.status, error: parsed.status === "success" ? parsed.value.error ?? "" : ""})
        }
        xhr.onerror = () => {cleanup(); reject(new Error(`Custom server network error for '${params.action}'`))}
        xhr.onabort = () => {cleanup(); reject(Errors.AbortError)}
        if (isDefined(signal)) {signal.addEventListener("abort", onAbort, {once: true})}
        xhr.send(data)
        return promise
    }

    #retryable(error: unknown, count: number): boolean {
        return count < CustomServerHandler.MaxAttempts && !this.#aborted() && !Errors.isAbort(error)
    }

    #aborted(): boolean {return isDefined(this.#signal) && this.#signal.aborted}
}
