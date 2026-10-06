import {afterEach, describe, expect, it, vi} from "vitest"
import {Errors, Progress, RuntimeNotifier} from "@opendaw/lib-std"

const files = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock("../Workers", () => ({
    Workers: {
        Opfs: {
            exists: async (path: string) => files.has(path),
            read: async (path: string) => {
                const bytes = files.get(path)
                if (bytes === undefined) {throw new Error(`NotFound ${path}`)}
                return bytes
            },
            write: async (path: string, bytes: Uint8Array) => {files.set(path, bytes.slice())},
            list: async (folder: string) => Array.from(new Set(Array.from(files.keys())
                .filter(path => path.startsWith(`${folder}/`))
                .map(path => path.split("/")[1])))
                .map(name => ({name, kind: "directory"}))
        }
    }
}))

import {CloudHandler} from "./CloudHandler"
import {CloudBackupWclaps} from "./CloudBackupWclaps"
import {WclapStorage} from "../wclap/WclapStorage"

class FakeCloud implements CloudHandler {
    readonly store = new Map<string, ArrayBuffer>()
    readonly uploads: Array<string> = []
    async upload(path: string, data: ArrayBuffer): Promise<void> {
        this.uploads.push(path)
        this.store.set(path, data)
    }
    async exists(path: string): Promise<boolean> {return this.store.has(path)}
    async download(path: string): Promise<ArrayBuffer> {
        const data = this.store.get(path)
        if (data === undefined) {throw new Errors.FileNotFound(path)}
        return data
    }
    async list(): Promise<string[]> {return Array.from(this.store.keys())}
    async delete(path: string): Promise<void> {this.store.delete(path)}
    async alive(): Promise<void> {}
    catalog(): Array<string> {
        const data = this.store.get(CloudBackupWclaps.RemoteCatalogPath)
        return data === undefined ? [] : JSON.parse(new TextDecoder().decode(data))
    }
    seed(ids: ReadonlyArray<string>): void {
        this.store.set(CloudBackupWclaps.RemoteCatalogPath, new TextEncoder().encode(JSON.stringify(ids)).buffer)
    }
}

RuntimeNotifier.install({
    info: async () => {},
    approve: async () => true,
    progress: () => ({message: "", terminate: () => {}}),
    notify: () => {}
})

const archive = (fill: number): ArrayBuffer => new Uint8Array(256).map((_, index) => (index * fill) & 0xff).buffer
const sync = (cloud: FakeCloud) => CloudBackupWclaps.start(cloud, Progress.Empty, () => {})

describe("CloudBackupWclaps", () => {
    afterEach(() => files.clear())

    it("uploads every stored bundle and lists it in the catalog", async () => {
        const id = WclapStorage.idOf(await WclapStorage.store(archive(3)))
        const cloud = new FakeCloud()
        await sync(cloud)
        expect(new Uint8Array(cloud.store.get(CloudBackupWclaps.pathFor(id))!)).toStrictEqual(new Uint8Array(archive(3)))
        expect(cloud.catalog()).toStrictEqual([id])
    })

    it("does not upload a bundle the catalog already lists", async () => {
        const id = WclapStorage.idOf(await WclapStorage.store(archive(3)))
        const cloud = new FakeCloud()
        cloud.seed([id])
        await sync(cloud)
        expect(cloud.uploads).toStrictEqual([])
    })

    it("restores a bundle from the cloud into storage", async () => {
        const id = WclapStorage.idOf(await WclapStorage.urlFor(archive(5)))
        const cloud = new FakeCloud()
        cloud.seed([id])
        cloud.store.set(CloudBackupWclaps.pathFor(id), archive(5))
        await sync(cloud)
        expect(new Uint8Array(await WclapStorage.loadId(id))).toStrictEqual(new Uint8Array(archive(5)))
    })

    it("does not store a cloud bundle whose content does not match its id", async () => {
        const id = WclapStorage.idOf(await WclapStorage.urlFor(archive(5)))
        const cloud = new FakeCloud()
        cloud.seed([id])
        cloud.store.set(CloudBackupWclaps.pathFor(id), archive(7))
        await sync(cloud)
        expect(await WclapStorage.exists(id)).toBe(false)
    })
})
