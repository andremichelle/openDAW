import {CloudStorageHandler} from "./CloudStorageHandler"
import {FileNotFoundError} from "./FileNotFoundError"
import {isDefined, Option, panic} from "@opendaw/lib-std"

type DriveFile = {
    id: string
    name: string
    mimeType?: string
}

type DriveListResponse = {
    files: Array<DriveFile>
    nextPageToken?: string
}

const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files"
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files"
const FOLDER_MIME = "application/vnd.google-apps.folder"
const ROOT_ID = "appDataFolder"

export class GoogleDriveHandler implements CloudStorageHandler {
    readonly #accessToken: string

    constructor(accessToken: string) {this.#accessToken = accessToken}

    async upload(path: string, data: ArrayBuffer): Promise<void> {
        const {dir, base} = this.#splitPath(path)
        const parentId = await this.#ensureFolderPath(dir)
        const existing = await this.#findFileInFolder(base, parentId)

        const metadata = {
            name: base,
            parents: [parentId]
        }

        // NOTE: pass ArrayBuffer, not Uint8Array, to avoid BlobPart typing issues
        const body = this.#buildMultipartBody(metadata, data)
        const headers = {
            "Authorization": `Bearer ${this.#accessToken}`,
            "Content-Type": `multipart/related; boundary=${body.boundary}`
        }

        if (existing.nonEmpty()) {
            const fileId = existing.unwrap().id
            const res = await fetch(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=multipart`, {
                method: "PATCH",
                headers,
                body: body.body
            })
            if (!res.ok) {
                const text = await res.text()
                return panic(`Google Drive update failed: ${res.status} ${text}`)
            }
        } else {
            const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart`, {
                method: "POST",
                headers,
                body: body.body
            })
            if (!res.ok) {
                const text = await res.text()
                return panic(`Google Drive upload failed: ${res.status} ${text}`)
            }
        }
    }

    async download(path: string): Promise<ArrayBuffer> {
        const fileId = await this.#resolveFileIdByPath(path)
        if (fileId.isEmpty()) {
            throw new FileNotFoundError(path)
        }
        const res = await fetch(`${DRIVE_FILES_API}/${fileId.unwrap()}?alt=media`, {
            method: "GET",
            headers: {"Authorization": `Bearer ${this.#accessToken}`}
        })
        if (!res.ok) {
            if (res.status === 404) throw new FileNotFoundError(path)
            const text = await res.text()
            return panic(`Google Drive download failed: ${res.status} ${text}`)
        }
        return await res.arrayBuffer()
    }

    async exists(path: string): Promise<boolean> {
        const fileId = await this.#resolveFileIdByPath(path)
        return fileId.nonEmpty()
    }

    async list(path?: string): Promise<string[]> {
        const folderId = await this.#resolveFolderId(path ?? "/")
        if (folderId.isEmpty()) return []
        const q = `'${folderId.unwrap()}' in parents and trashed = false`
        const names: string[] = []
        let pageToken: string | undefined = undefined
        do {
            const params = new URLSearchParams({
                q,
                fields: "files(id,name,mimeType),nextPageToken",
                pageSize: "1000"
            })
            if (pageToken) params.set("pageToken", pageToken)
            const res = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {
                headers: {"Authorization": `Bearer ${this.#accessToken}`}
            })
            if (!res.ok) {
                const text = await res.text()
                return panic(`Google Drive list failed: ${res.status} ${text}`)
            }
            const json: DriveListResponse = await res.json()
            json.files.forEach(f => names.push(f.name))
            pageToken = json.nextPageToken
        } while (isDefined(pageToken))
        return names
    }

    async delete(path: string): Promise<void> {
        const fileId = await this.#resolveFileIdByPath(path)
        if (fileId.isEmpty()) {
            // deleting a non-existent file should be a no-op
            return
        }
        const res = await fetch(`${DRIVE_FILES_API}/${fileId.unwrap()}`, {
            method: "DELETE",
            headers: {"Authorization": `Bearer ${this.#accessToken}`}
        })
        if (!res.ok && res.status !== 404) {
            const text = await res.text()
            return panic(`Google Drive delete failed: ${res.status} ${text}`)
        }
    }

    // ---------- Helpers ----------

    #authHeaders(): HeadersInit {
        return {"Authorization": `Bearer ${this.#accessToken}`}
    }

    #splitPath(path: string): { dir: string[]; base: string } {
        const clean = path.replace(/^\/*/, "") // remove leading slashes
        const parts = clean.split("/").filter(p => p.length > 0)
        if (parts.length === 0) return {dir: [], base: ""}
        const base = parts.pop() as string
        return {dir: parts, base}
    }

    async #resolveFileIdByPath(path: string): Promise<Option<string>> {
        const {dir, base} = this.#splitPath(path)
        const parentId = await this.#resolveFolderPath(dir)
        if (parentId.isEmpty() || base.length === 0) return Option.None
        const existing = await this.#findFileInFolder(base, parentId.unwrap())
        return existing.map(f => f.id)
    }

    async #resolveFolderId(path: string): Promise<Option<string>> {
        if (path === "/" || path.trim() === "") return Option.wrap(ROOT_ID)
        const parts = path.replace(/^\/*/, "").split("/").filter(Boolean)
        return this.#resolveFolderPath(parts)
    }

    // Resolve a folder path without creating anything
    async #resolveFolderPath(parts: string[]): Promise<Option<string>> {
        let currentId: string = ROOT_ID
        for (const part of parts) {
            const next = await this.#findFolderInFolder(part, currentId)
            if (next.isEmpty()) return Option.None
            currentId = next.unwrap().id
        }
        return Option.wrap(currentId)
    }

    // Ensure folder path exists, create missing segments
    async #ensureFolderPath(parts: string[]): Promise<string> {
        let currentId: string = ROOT_ID
        for (const part of parts) {
            const found = await this.#findFolderInFolder(part, currentId)
            if (found.nonEmpty()) {
                currentId = found.unwrap().id
                continue
            }
            const created = await this.#createFolder(part, currentId)
            currentId = created.id
        }
        return currentId
    }

    async #findFolderInFolder(name: string, parentId: string): Promise<Option<DriveFile>> {
        const q = [
            `name = '${name.replace(/'/g, "\\'")}'`,
            `'${parentId}' in parents`,
            `mimeType = '${FOLDER_MIME}'`,
            `trashed = false`
        ].join(" and ")
        const params = new URLSearchParams({
            q,
            fields: "files(id,name,mimeType)",
            pageSize: "1"
        })
        const res = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {headers: this.#authHeaders()})
        if (!res.ok) {
            const text = await res.text()
            return panic(`Google Drive query failed: ${res.status} ${text}`)
        }
        const json: DriveListResponse = await res.json()
        return Option.wrap(json.files[0])
    }

    async #findFileInFolder(name: string, parentId: string): Promise<Option<DriveFile>> {
        const q = [
            `name = '${name.replace(/'/g, "\\'")}'`,
            `'${parentId}' in parents`,
            `mimeType != '${FOLDER_MIME}'`,
            `trashed = false`
        ].join(" and ")
        const params = new URLSearchParams({
            q,
            fields: "files(id,name,mimeType)",
            pageSize: "1"
        })
        const res = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {headers: this.#authHeaders()})
        if (!res.ok) {
            const text = await res.text()
            return panic(`Google Drive query failed: ${res.status} ${text}`)
        }
        const json: DriveListResponse = await res.json()
        return Option.wrap(json.files[0])
    }

    async #createFolder(name: string, parentId: string): Promise<DriveFile> {
        const metadata = {
            name,
            mimeType: FOLDER_MIME,
            parents: [parentId]
        }
        const res = await fetch(DRIVE_FILES_API, {
            method: "POST",
            headers: {
                ...this.#authHeaders(),
                "Content-Type": "application/json"
            },
            body: JSON.stringify(metadata)
        })
        if (!res.ok) {
            const text = await res.text()
            return panic(`Google Drive create folder failed: ${res.status} ${text}`)
        }
        return await res.json() as DriveFile
    }

    #buildMultipartBody(metadata: any, content: ArrayBuffer): { boundary: string; body: Blob } {
        const boundary = `======opendaw_${Math.random().toString(36).slice(2)}`
        const delimiter = `--${boundary}`
        const close = `--${boundary}--`

        const metaHeader =
            `${delimiter}\r\n` +
            "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
            `${JSON.stringify(metadata)}\r\n`

        const binHeader =
            `${delimiter}\r\n` +
            "Content-Type: application/octet-stream\r\n\r\n"

        // Use ArrayBuffer (content) as BlobPart directly to satisfy TS typings
        const body = new Blob([
            metaHeader,
            binHeader,
            content,
            `\r\n${close}\r\n`
        ])
        return {boundary, body}
    }
}