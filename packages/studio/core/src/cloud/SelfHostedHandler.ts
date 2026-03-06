import {Errors} from "@opendaw/lib-std"
import {CloudHandler} from "./CloudHandler"

export class SelfHostedHandler implements CloudHandler {
    readonly #baseUrl: string

    constructor(baseUrl: string) {this.#baseUrl = baseUrl.replace(/\/$/, "")}

    async alive(): Promise<void> {
        const response = await fetch(`${this.#baseUrl}/health`)
        if (!response.ok) {throw new Error(`Storage server unreachable: ${response.status}`)}
    }

    async upload(path: string, data: ArrayBuffer): Promise<void> {
        const response = await fetch(`${this.#baseUrl}/files/${encodeURIComponent(path)}`, {
            method: "PUT",
            body: data
        })
        if (!response.ok) {throw new Error(`Upload failed: ${response.status}`)}
    }

    async download(path: string): Promise<ArrayBuffer> {
        const response = await fetch(`${this.#baseUrl}/files/${encodeURIComponent(path)}`)
        if (response.status === 404) {throw new Errors.FileNotFound(path)}
        if (!response.ok) {throw new Error(`Download failed: ${response.status}`)}
        return response.arrayBuffer()
    }

    async exists(path: string): Promise<boolean> {
        const response = await fetch(`${this.#baseUrl}/files/${encodeURIComponent(path)}`, {method: "HEAD"})
        return response.ok
    }

    async list(path?: string): Promise<Array<string>> {
        const params = path ? `?prefix=${encodeURIComponent(path)}` : ""
        const response = await fetch(`${this.#baseUrl}/files/${params}`)
        if (!response.ok) {throw new Error(`List failed: ${response.status}`)}
        return response.json()
    }

    async delete(path: string): Promise<void> {
        const response = await fetch(`${this.#baseUrl}/files/${encodeURIComponent(path)}`, {method: "DELETE"})
        if (!response.ok) {throw new Error(`Delete failed: ${response.status}`)}
    }
}
