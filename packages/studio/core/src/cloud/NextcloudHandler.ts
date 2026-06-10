import {Errors, isDefined, Optional, panic, Progress, unitValue} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"

export type NextcloudCredentials = {
    baseUrl: string
    username: string
    appPassword: string
}

// Files larger than this are uploaded in chunks (Nextcloud chunked upload v2). Chunk size must be
// between 5 MB and 5 GB; 10 MB keeps us safely above the minimum and well under typical proxy caps.
const ChunkSize = 10 * 1024 * 1024

// Total attempts (1 initial + retries) for transient read/metadata requests before giving up.
const MaxFetchAttempts = 4

export class NextcloudHandler implements CloudHandler {
    readonly #davBase: string
    readonly #uploadsBase: string
    readonly #authHeader: string
    readonly #knownCollections: Set<string>
    readonly #collectionChildren: Map<string, Set<string>>
    readonly #signal: Optional<AbortSignal>

    constructor({baseUrl, username, appPassword}: NextcloudCredentials, signal?: AbortSignal) {
        const root = baseUrl.trim().replace(/\/+$/, "")
        const user = encodeURIComponent(username)
        this.#davBase = `${root}/remote.php/dav/files/${user}`
        this.#uploadsBase = `${root}/remote.php/dav/uploads/${user}`
        this.#authHeader = `Basic ${btoa(`${username}:${appPassword}`)}`
        this.#knownCollections = new Set<string>()
        this.#collectionChildren = new Map<string, Set<string>>()
        this.#signal = signal
    }

    async alive(): Promise<void> {
        const response = await this.#request("", {method: "PROPFIND", headers: {Depth: "0"}})
        if (response.status === 207 || response.ok) {return}
        if (response.status === 401) {return panic("Authentication failed. Check the username and app password.")}
        return panic(`Nextcloud not reachable (${response.status})`)
    }

    async upload(path: string, data: ArrayBuffer, progress?: Progress.Handler): Promise<void> {
        if (data.byteLength > ChunkSize) {return this.#uploadChunked(path, data, progress)}
        await this.#ensureParents(path)
        const status = await this.#put(this.#url(path), data, {}, progress)
        if (status < 200 || status >= 300) {return panic(NextcloudHandler.#uploadError(status, path))}
        progress?.(1.0)
    }

    // Nextcloud chunked upload v2: create a session folder (Destination = final file), PUT each chunk
    // named 00001.., then MOVE the synthetic .file to assemble. Avoids single-PUT size limits and
    // gives byte-level progress across the whole file.
    async #uploadChunked(path: string, data: ArrayBuffer, progress?: Progress.Handler): Promise<void> {
        await this.#ensureParents(path)
        const destination = this.#url(path)
        const total = data.byteLength
        const session = `${this.#uploadsBase}/opendaw-${crypto.randomUUID()}`
        const created = await this.#fetch(session, {method: "MKCOL", headers: {Destination: destination}})
        if (!created.ok) {return panic(`Nextcloud could not create upload session (${created.status})`)}
        const chunkCount = Math.ceil(total / ChunkSize)
        for (let index = 0; index < chunkCount; index++) {
            const start = index * ChunkSize
            const end = Math.min(start + ChunkSize, total)
            const name = String(index + 1).padStart(5, "0")
            const status = await this.#put(`${session}/${name}`, data.slice(start, end), {Destination: destination},
                (fraction: unitValue) => progress?.((start + fraction * (end - start)) / total))
            if (status < 200 || status >= 300) {return panic(NextcloudHandler.#uploadError(status, path))}
        }
        const assembled = await this.#fetch(`${session}/.file`,
            {method: "MOVE", headers: {Destination: destination, "OC-Total-Length": String(total)}})
        if (!assembled.ok) {return panic(`Nextcloud could not assemble chunks (${assembled.status}) for '${path}'`)}
        progress?.(1.0)
    }

    // Retries the PUT on transient network failures (a chunk PUT is idempotent within its session, a
    // small PUT overwrites), so a single dropped connection does not fail the whole upload. Aborts
    // are not retried.
    #put(url: string, data: ArrayBuffer, headers: Record<string, string>,
         progress?: Progress.Handler): Promise<number> {
        return Promises.guardedRetry(() => this.#putOnce(url, data, headers, progress),
            (error, count) => count < MaxFetchAttempts && !this.#aborted() && !Errors.isAbort(error))
    }

    // Uploads via XHR rather than fetch because only XHR exposes upload progress events.
    #putOnce(url: string, data: ArrayBuffer, headers: Record<string, string>,
             progress?: Progress.Handler): Promise<number> {
        const {promise, resolve, reject} = Promise.withResolvers<number>()
        const signal = this.#signal
        const xhr = new XMLHttpRequest()
        const onAbort = () => xhr.abort()
        // Detach the abort listener once the request settles, so listeners do not accumulate on the
        // shared signal across many sequential uploads.
        const cleanup = () => {if (isDefined(signal)) {signal.removeEventListener("abort", onAbort)}}
        xhr.open("PUT", url)
        xhr.setRequestHeader("Authorization", this.#authHeader)
        for (const [key, value] of Object.entries(headers)) {xhr.setRequestHeader(key, value)}
        if (isDefined(progress)) {
            xhr.upload.onprogress = event => {if (event.lengthComputable) {progress(event.loaded / event.total)}}
        }
        xhr.onload = () => {
            cleanup()
            if (NextcloudHandler.#isTransient(xhr.status)) {
                reject(new Error(`Nextcloud transient status ${xhr.status} for '${url}'`))
            } else {
                resolve(xhr.status)
            }
        }
        xhr.onerror = () => {cleanup(); reject(new Error(`Upload network error for '${url}'`))}
        xhr.onabort = () => {cleanup(); reject(Errors.AbortError)}
        if (isDefined(signal)) {
            if (signal.aborted) {xhr.abort()} else {signal.addEventListener("abort", onAbort, {once: true})}
        }
        xhr.send(data)
        return promise
    }

    async download(path: string): Promise<ArrayBuffer> {
        const response = await this.#request(path, {method: "GET"})
        if (response.status === 404) {return Promise.reject(new Errors.FileNotFound(path))}
        if (!response.ok) {return panic(`Nextcloud download failed (${response.status}) for '${path}'`)}
        return response.arrayBuffer()
    }

    async exists(path: string): Promise<boolean> {
        const response = await this.#request(path, {method: "PROPFIND", headers: {Depth: "0"}})
        if (response.status === 404) {return false}
        if (response.status === 207 || response.ok) {return true}
        return panic(`Nextcloud exists check failed (${response.status}) for '${path}'`)
    }

    async list(path?: string): Promise<Array<string>> {
        const target = path ?? ""
        const response = await this.#request(target, {method: "PROPFIND", headers: {Depth: "1"}})
        if (response.status === 404) {return []}
        if (!(response.status === 207 || response.ok)) {
            return panic(`Nextcloud list failed (${response.status}) for '${target}'`)
        }
        const text = await response.text()
        const self = decodeURIComponent(new URL(this.#url(target)).pathname).replace(/\/+$/, "")
        return NextcloudHandler.#parseListing(text, self)
    }

    async delete(path: string): Promise<void> {
        const response = await this.#request(path, {method: "DELETE"})
        if (!response.ok && response.status !== 404) {
            return panic(`Nextcloud delete failed (${response.status}) for '${path}'`)
        }
    }

    // Creates missing parent collections without ever issuing a request that returns a non-2xx
    // status (which the browser would log). For each level we list the parent (always exists by
    // induction, so PROPFIND returns 207) and only MKCOL the child when it is absent (returns 201).
    async #ensureParents(path: string): Promise<void> {
        const segments = path.replace(/^\/+/, "").split("/")
        segments.pop()
        let parent = ""
        for (const segment of segments) {
            const current = parent.length === 0 ? segment : `${parent}/${segment}`
            if (!this.#knownCollections.has(current)) {
                const children = await this.#childrenOf(parent)
                if (!children.has(segment)) {
                    const response = await this.#request(current, {method: "MKCOL"})
                    if (!response.ok && response.status !== 405) {
                        return panic(`Nextcloud MKCOL failed (${response.status}) for '${current}'`)
                    }
                    children.add(segment)
                }
                this.#knownCollections.add(current)
            }
            parent = current
        }
    }

    // Lists a folder's child names once and caches them, so creating many siblings (e.g. one folder
    // per asset) does not re-issue a PROPFIND per sibling.
    async #childrenOf(folder: string): Promise<Set<string>> {
        const cached = this.#collectionChildren.get(folder)
        if (isDefined(cached)) {return cached}
        const children = new Set(await this.list(folder))
        this.#collectionChildren.set(folder, children)
        return children
    }

    #request(path: string, init: RequestInit): Promise<Response> {
        return this.#fetch(this.#url(path), init)
    }

    // Retries on transient network failures (e.g. ERR_HTTP2_PROTOCOL_ERROR, dropped connections) and
    // transient server statuses (502/503/504), which occur intermittently against Nextcloud. Aborts
    // are never retried and surface as AbortError.
    async #fetch(url: string, init: RequestInit): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set("Authorization", this.#authHeader)
        const result = await Promises.tryCatch(Promises.guardedRetry(
            () => fetch(url, {...init, headers, signal: this.#signal})
                .then(response => NextcloudHandler.#isTransient(response.status)
                    ? Promise.reject(new Error(`Nextcloud transient status ${response.status} for '${url}'`))
                    : response),
            (error, count) => count < MaxFetchAttempts && !this.#aborted() && !Errors.isAbort(error)))
        if (result.status === "resolved") {return result.value}
        if (this.#aborted()) {return Promise.reject(Errors.AbortError)}
        return panic(String(result.error))
    }

    #aborted(): boolean {return isDefined(this.#signal) && this.#signal.aborted}

    // 423 = WebDAV file lock (Nextcloud transactional locking), which clears on its own shortly; 5xx
    // are transient server hiccups. All are safe to retry.
    static #isTransient(status: number): boolean {
        return status === 423 || status === 502 || status === 503 || status === 504
    }

    static #uploadError(status: number, path: string): string {
        return status === 507
            ? "Nextcloud storage is full (quota exceeded)."
            : `Nextcloud upload failed (${status}) for '${path}'`
    }

    #url(path: string): string {
        const clean = path.replace(/^\/+/, "")
        if (clean.length === 0) {return this.#davBase}
        return `${this.#davBase}/${clean.split("/").map(encodeURIComponent).join("/")}`
    }

    static #parseListing(xml: string, selfPathname: string): Array<string> {
        const document = new DOMParser().parseFromString(xml, "application/xml")
        const names: Array<string> = []
        for (const node of Array.from(document.getElementsByTagNameNS("DAV:", "href"))) {
            const href = node.textContent
            if (!isDefined(href)) {continue}
            const pathname = decodeURIComponent(new URL(href, "https://host").pathname).replace(/\/+$/, "")
            if (pathname === selfPathname) {continue}
            const name = pathname.substring(pathname.lastIndexOf("/") + 1)
            if (name.length > 0) {names.push(name)}
        }
        return names
    }
}
