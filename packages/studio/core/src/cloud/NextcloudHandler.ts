import {Errors, isDefined, panic} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {CloudHandler} from "./CloudHandler"

export type NextcloudCredentials = {
    baseUrl: string
    username: string
    appPassword: string
}

export class NextcloudHandler implements CloudHandler {
    readonly #davBase: string
    readonly #authHeader: string
    readonly #knownCollections: Set<string>

    constructor({baseUrl, username, appPassword}: NextcloudCredentials) {
        const root = baseUrl.trim().replace(/\/+$/, "")
        this.#davBase = `${root}/remote.php/dav/files/${encodeURIComponent(username)}`
        this.#authHeader = `Basic ${btoa(`${username}:${appPassword}`)}`
        this.#knownCollections = new Set<string>()
    }

    async alive(): Promise<void> {
        const response = await this.#request("", {method: "PROPFIND", headers: {Depth: "0"}})
        if (response.status === 207 || response.ok) {return}
        return panic(`Nextcloud not reachable (${response.status})`)
    }

    async upload(path: string, data: ArrayBuffer): Promise<void> {
        await this.#ensureParents(path)
        const response = await this.#request(path, {method: "PUT", body: data})
        if (!response.ok) {return panic(`Nextcloud upload failed (${response.status}) for '${path}'`)}
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
                const children = await this.list(parent)
                if (!children.includes(segment)) {
                    const response = await this.#request(current, {method: "MKCOL"})
                    if (!response.ok && response.status !== 405) {
                        return panic(`Nextcloud MKCOL failed (${response.status}) for '${current}'`)
                    }
                }
                this.#knownCollections.add(current)
            }
            parent = current
        }
    }

    async #request(path: string, init: RequestInit): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set("Authorization", this.#authHeader)
        const {status, value, error} = await Promises.tryCatch(fetch(this.#url(path), {...init, headers}))
        if (status === "rejected") {return panic(String(error))}
        return value
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
