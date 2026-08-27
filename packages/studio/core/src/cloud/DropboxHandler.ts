import type {Dropbox, DropboxResponse, files} from "dropbox"
import {Errors, isDefined, Option, panic} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"

export class DropboxHandler implements CloudHandler {
    readonly #accessToken: string

    #dropboxClient: Option<Dropbox> = Option.None

    constructor(accessToken: string) {this.#accessToken = accessToken}

    async alive(): Promise<void> {
        const client = await this.#ensureClient()
        const {status, error} = await Promises.tryCatch(client.usersGetCurrentAccount())
        if (status === "rejected") return panic(this.#describe("alive", "/", error))
    }

    async upload(path: string, buffer: ArrayBuffer): Promise<void> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)
        console.debug("[Dropbox] Uploading to:", fullPath)
        const {status, error, value: result} = await Promises.tryCatch(client
            .filesUpload({path: fullPath, contents: buffer, mode: {".tag": "overwrite"}}))
        if (status === "rejected") {
            return panic(this.#describe("upload", fullPath, error))
        } else {
            console.debug("[Dropbox] Upload successful:", result.result.path_display)
        }
    }

    async download(path: string): Promise<ArrayBuffer> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)
        try {
            const response = await client.filesDownload({path: fullPath})
            const {result: {fileBlob}} = response as DropboxResponse<files.FileMetadata & { fileBlob: Blob }>
            return fileBlob.arrayBuffer()
        } catch (error) {
            if (this.#isNotFoundError(error)) {
                throw new Errors.FileNotFound(path)
            }
            throw new Error(this.#describe("download", fullPath, error))
        }
    }

    async exists(path: string): Promise<boolean> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)
        const {
            status,
            error
        } = await Promises.tryCatch(client.filesGetMetadata({path: fullPath})).catch(error => (error as any))
        if (status === "resolved") return true
        return this.#isNotFoundError(error) ? false : panic(this.#describe("exists", fullPath, error))
    }

    async list(path?: string): Promise<Array<string>> {
        const client = await this.#ensureClient()
        const fullPath = path ? this.#getFullPath(path) : ""
        const {status, error, value: response} = await Promises.tryCatch(client.filesListFolder({path: fullPath}))
        if (status === "rejected") {return panic(this.#describe("list", fullPath, error))}
        return response.result.entries.map(entry => entry.name).filter(isDefined)
    }

    async delete(path: string): Promise<void> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)
        const {status, error} = await Promises.tryCatch(client.filesDeleteV2({path: fullPath}))
        if (status === "rejected") {return panic(this.#describe("delete", fullPath, error))}
    }

    async #ensureClient(): Promise<Dropbox> {
        if (this.#dropboxClient.isEmpty()) {
            const DropboxModule = await import("dropbox")
            this.#dropboxClient = Option.wrap(new DropboxModule.Dropbox({accessToken: this.#accessToken}))
        }
        return this.#dropboxClient.unwrap()
    }

    #getFullPath(path: string): string {
        if (path.includes(":") || path.includes("T")) {
            const filename = path.replace(/:/g, "-")
            return filename.startsWith("/") ? filename : `/${filename}`
        }
        return path.startsWith("/") ? path : `/${path}`
    }

    #describe(operation: string, path: string, error: unknown): string {
        const response = error as {status?: number, error?: {error_summary?: string} | string}
        const body = response?.error
        const summary = typeof body === "string" ? body : body?.error_summary ?? String(error)
        return `Dropbox ${operation} '${path}' failed (${response?.status ?? "?"}): ${summary}`
    }

    #isNotFoundError(error: unknown): boolean {
        return (
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error as any).status === 409 &&
            (error as any).error?.error?.[".tag"] === "path" &&
            (error as any).error?.error?.path?.[".tag"] === "not_found"
        )
    }
}