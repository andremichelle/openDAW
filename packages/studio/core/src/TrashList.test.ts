import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {TrashList} from "./TrashList"

const createFiles = (free: number) => {
    const files = new Map<string, Uint8Array>()
    const disk = {free}
    const api: TrashList.Files = {
        read: async (path: string) => {
            const bytes = files.get(path)
            if (bytes === undefined) {throw new DOMException("missing", "NotFoundError")}
            return bytes
        },
        write: async (path: string, bytes: Uint8Array) => {
            const previous = files.get(path)?.length ?? 0
            if (bytes.length - previous > disk.free) {
                if (previous === 0) {files.set(path, new Uint8Array(0))}
                throw new DOMException("No space", "QuotaExceededError")
            }
            disk.free -= bytes.length - previous
            files.set(path, bytes.slice())
        },
        delete: async (path: string) => Array.from(files.keys())
            .filter(key => key === path || key.startsWith(`${path}/`))
            .forEach(key => {
                disk.free += files.get(key)?.length ?? 0
                files.delete(key)
            })
    }
    return {files, disk, api}
}
const id = (): UUID.String => UUID.toString(UUID.generate())

describe("TrashList", () => {
    it("records the id before it removes the folder", async () => {
        const {files, api} = createFiles(Number.POSITIVE_INFINITY)
        const uuid = id()
        files.set(`projects/v1/${uuid}/project.od`, new Uint8Array(10))
        await TrashList.deleteRecorded(api, "projects/v1/trash.json", uuid, `projects/v1/${uuid}`)
        expect(files.has(`projects/v1/${uuid}/project.od`)).toBe(false)
        expect(await TrashList.read(api, "projects/v1/trash.json")).toEqual([uuid])
    })
    it("still removes the folder on a full disk and records it once there is room", async () => {
        const {files, api} = createFiles(0)
        const uuid = id()
        files.set(`projects/v1/${uuid}/project.od`, new Uint8Array(500))
        await TrashList.deleteRecorded(api, "projects/v1/trash.json", uuid, `projects/v1/${uuid}`)
        expect(files.has(`projects/v1/${uuid}/project.od`)).toBe(false)
        expect(await TrashList.read(api, "projects/v1/trash.json")).toEqual([uuid])
    })
    it("does not remove the folder when the list fails for another reason", async () => {
        const {files, api} = createFiles(Number.POSITIVE_INFINITY)
        const uuid = id()
        files.set(`projects/v1/${uuid}/project.od`, new Uint8Array(10))
        const broken: TrashList.Files = {...api, write: async () => {throw new DOMException("gone", "InvalidStateError")}}
        await expect(TrashList.deleteRecorded(broken, "projects/v1/trash.json", uuid, `projects/v1/${uuid}`)).rejects.toThrow("gone")
        expect(files.has(`projects/v1/${uuid}/project.od`)).toBe(true)
    })
    it("reads a missing or empty list as no trash", async () => {
        const {files, api} = createFiles(Number.POSITIVE_INFINITY)
        files.set("a.json", new Uint8Array(0))
        expect(await TrashList.read(api, "a.json")).toEqual([])
        expect(await TrashList.read(api, "missing.json")).toEqual([])
    })
    it("never overwrites a damaged list and keeps the folder", async () => {
        const {files, api} = createFiles(Number.POSITIVE_INFINITY)
        const uuid = id()
        files.set("t.json", new TextEncoder().encode("{\"x\":1}"))
        files.set(`f/${uuid}`, new Uint8Array(1))
        await expect(TrashList.deleteRecorded(api, "t.json", uuid, `f/${uuid}`)).rejects.toThrow("is damaged")
        expect(new TextDecoder().decode(files.get("t.json"))).toBe("{\"x\":1}")
        expect(files.has(`f/${uuid}`)).toBe(true)
    })
    it("reports a deletion it could not note for the cloud backup", async () => {
        const {files, disk, api} = createFiles(0)
        const uuid = id()
        files.set(`f/${uuid}/x`, new Uint8Array(0))
        await expect(TrashList.deleteRecorded(api, "t.json", uuid, `f/${uuid}`)).rejects.toThrow("too full to note it")
        expect(files.has(`f/${uuid}/x`)).toBe(false)
        expect(disk.free).toBe(0)
    })
    it("does not record an id twice", async () => {
        const {api} = createFiles(Number.POSITIVE_INFINITY)
        const uuid = id()
        await TrashList.deleteRecorded(api, "t.json", uuid, "f")
        await TrashList.deleteRecorded(api, "t.json", uuid, "f")
        expect(await TrashList.read(api, "t.json")).toEqual([uuid])
    })
})
