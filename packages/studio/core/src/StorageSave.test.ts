import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Terminable, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"

// a disk with a budget: a write that does not fit leaves an empty file and throws, like OpfsWorker
const disk = vi.hoisted(() => ({
    files: new Map<string, Uint8Array>(),
    free: Number.POSITIVE_INFINITY,
    writes: [] as Array<string>,
    active: 0,
    maxActive: 0,
    reset() {
        this.files.clear()
        this.free = Number.POSITIVE_INFINITY
        this.writes.length = 0
        this.active = 0
        this.maxActive = 0
    }
}))

vi.mock("./Workers", () => ({
    Workers: {
        Opfs: {
            write: async (path: string, bytes: Uint8Array) => {
                disk.active++
                disk.maxActive = Math.max(disk.maxActive, disk.active)
                await new Promise(resolve => setTimeout(resolve, 1))
                disk.active--
                disk.writes.push(path)
                const previous = disk.files.get(path)?.length ?? 0
                if (bytes.length - previous > disk.free) {
                    if (previous === 0) {disk.files.set(path, new Uint8Array(0))}
                    throw new DOMException("No space available for this operation", "QuotaExceededError")
                }
                disk.free -= bytes.length - previous
                disk.files.set(path, bytes.slice())
            },
            read: async (path: string) => {
                const bytes = disk.files.get(path)
                if (bytes === undefined) {throw new DOMException(`${path} not found`, "NotFoundError")}
                return bytes
            },
            exists: async (path: string) => Array.from(disk.files.keys()).some(key => key === path || key.startsWith(`${path}/`)),
            delete: async (path: string) => {
                Array.from(disk.files.keys())
                    .filter(key => key === path || key.startsWith(`${path}/`))
                    .forEach(key => {
                        disk.free += disk.files.get(key)?.length ?? 0
                        disk.files.delete(key)
                    })
            },
            list: async () => []
        }
    }
}))

import {OpfsQuota} from "./OpfsQuota"
import {SampleStorage} from "./samples/SampleStorage"
import {SoundfontStorage} from "./soundfont/SoundfontStorage"
import {PresetStorage} from "./presets/PresetStorage"
import type {PresetMeta} from "./presets/PresetMeta"

const sample = (frames: number) => {
    const uuid = UUID.generate()
    const audio = AudioData.create(48000, frames, 1)
    audio.frames[0].fill(0.25)
    return {
        uuid,
        audio,
        peaks: new Uint8Array(16).buffer,
        meta: {name: "Kick", bpm: 120, duration: frames / 48000, sample_rate: 48000, origin: "openDAW" as const}
    }
}
const folderOf = (uuid: UUID.Bytes) => `${SampleStorage.Folder}/${UUID.toString(uuid)}`
const filesOf = (uuid: UUID.Bytes) => Array.from(disk.files.keys())
    .filter(path => path.startsWith(`${folderOf(uuid)}/`))
    .map(path => path.substring(folderOf(uuid).length + 1))
    .sort()

describe("Storage saves", () => {
    const installed: Array<Terminable> = []
    beforeEach(() => {
        disk.reset()
        vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(console, "debug").mockImplementation(() => {})
    })
    afterEach(() => {
        installed.splice(0).forEach(terminable => terminable.terminate())
        vi.restoreAllMocks()
    })

    it("writes a sample's files one after another with meta.json last", async () => {
        const entry = sample(100)
        await SampleStorage.get().save(entry)
        const folder = folderOf(entry.uuid)
        expect(disk.writes).toEqual([`${folder}/audio.wav`, `${folder}/peaks.bin`, `${folder}/meta.json`])
        expect(disk.maxActive).toBe(1)
    })

    it("writes a soundfont's meta.json last", async () => {
        const uuid = UUID.generate()
        const meta = {name: "Piano", size: 4, url: "", license: "", origin: "openDAW" as const}
        await SoundfontStorage.get().save({uuid, file: new Uint8Array([1, 2, 3, 4]).buffer, meta})
        const folder = `${SoundfontStorage.Folder}/${UUID.toString(uuid)}`
        expect(disk.writes).toEqual([`${folder}/soundfont.sf2`, `${folder}/meta.json`])
    })

    it("removes everything a sample save wrote when the disk is full", async () => {
        const entry = sample(1000)
        disk.free = 100
        const result = await SampleStorage.get().save(entry).then(() => null, reason => reason)
        expect(OpfsQuota.isExceeded(result)).toBe(true)
        expect(filesOf(entry.uuid)).toEqual([])
        expect(disk.free).toBe(100)
    })

    it("removes a save that failed half way, after its audio file fit", async () => {
        const entry = sample(1000)
        const wavBytes = 44 + 1000 * 4
        disk.free = wavBytes + 4
        await expect(SampleStorage.get().save(entry)).rejects.toThrow()
        expect(filesOf(entry.uuid)).toEqual([])
        expect(disk.free).toBe(wavBytes + 4)
    })

    it("keeps a sample that was stored before when saving it again fails", async () => {
        const entry = sample(1000)
        await SampleStorage.get().save(entry)
        const before = new Map(Array.from(disk.files).filter(([path]) => path.startsWith(folderOf(entry.uuid))))
        disk.free = 0
        await expect(SampleStorage.get().save({...entry, meta: {...entry.meta, name: "A longer name than before"}}))
            .rejects.toThrow("No space")
        expect(filesOf(entry.uuid)).toEqual(["audio.wav", "meta.json", "peaks.bin"])
        before.forEach((bytes, path) => expect(disk.files.get(path)).toEqual(bytes))
    })

    it("leaves a folder alone that existed before a failed save", async () => {
        const entry = sample(1000)
        disk.files.set(`${folderOf(entry.uuid)}/audio.wav`, new Uint8Array(10))
        disk.free = 100
        await expect(SampleStorage.get().save(entry)).rejects.toThrow()
        expect(filesOf(entry.uuid)).toEqual(["audio.wav"])
    })

    it("marks a sample the loader fetched as cached for the handler", async () => {
        const events: Array<OpfsQuota.Exceeded> = []
        installed.push(OpfsQuota.install(async event => {
            events.push(event)
            return false
        }))
        disk.free = 0
        await expect(SampleStorage.get().save(sample(100), true)).rejects.toThrow()
        await expect(SampleStorage.get().save(sample(100))).rejects.toThrow()
        expect(events.map(({cached}) => cached)).toEqual([true, false])
    })

    it("removes a new preset file when the preset index does not fit", async () => {
        const uuid = UUID.toString(UUID.generate())
        const meta = {uuid, name: "Lead", description: "", created: 0, modified: 0,
            category: "instrument", device: "Vaporisateur"} as unknown as PresetMeta
        disk.files.set("presets/user/index.json", new TextEncoder().encode("[]"))
        disk.free = 64
        await expect(PresetStorage.save(meta, new Uint8Array(40).buffer)).rejects.toThrow("No space")
        expect(disk.files.has(`presets/user/${uuid}.odp`)).toBe(false)
        expect(new TextDecoder().decode(disk.files.get("presets/user/index.json"))).toBe("[]")
    })

    it("still deletes a preset whose trash list is damaged and reports it", async () => {
        const uuid = UUID.toString(UUID.generate())
        const entry = {uuid, name: "Lead"}
        disk.files.set("presets/user/index.json", new TextEncoder().encode(JSON.stringify([entry])))
        disk.files.set(`presets/user/${uuid}.odp`, new Uint8Array(8))
        disk.files.set("presets/user/trash.json", new TextEncoder().encode("{broken"))
        await expect(PresetStorage.remove(UUID.parse(uuid))).rejects.toThrow("is damaged")
        expect(disk.files.has(`presets/user/${uuid}.odp`)).toBe(false)
        expect(JSON.parse(new TextDecoder().decode(disk.files.get("presets/user/index.json")))).toEqual([])
        expect(new TextDecoder().decode(disk.files.get("presets/user/trash.json"))).toBe("{broken")
    })

    it("records a deleted entry in the trash list before it removes it", async () => {
        const entry = sample(10)
        await SampleStorage.get().save(entry)
        disk.writes.length = 0
        await SampleStorage.get().deleteItem(entry.uuid)
        expect(disk.writes).toEqual([`${SampleStorage.Folder}/trash.json`])
        expect(JSON.parse(new TextDecoder().decode(disk.files.get(`${SampleStorage.Folder}/trash.json`))))
            .toEqual([UUID.toString(entry.uuid)])
    })

    it("reads a trash list that a full disk left empty as no trash", async () => {
        const entry = sample(10)
        await SampleStorage.get().save(entry)
        disk.files.set(`${SampleStorage.Folder}/trash.json`, new Uint8Array(0))
        await SampleStorage.get().deleteItem(entry.uuid)
        expect(filesOf(entry.uuid)).toEqual([])
        expect(await SampleStorage.get().loadTrashedIds()).toEqual([UUID.toString(entry.uuid)])
    })

    it("still deletes an entry when its trash list cannot grow", async () => {
        const entry = sample(10)
        await SampleStorage.get().save(entry)
        disk.free = 0
        await SampleStorage.get().deleteItem(entry.uuid)
        expect(filesOf(entry.uuid)).toEqual([])
        expect(JSON.parse(new TextDecoder().decode(disk.files.get(`${SampleStorage.Folder}/trash.json`))))
            .toEqual([UUID.toString(entry.uuid)])
    })

    it("saves the whole sample again after the handler made room", async () => {
        const blocker = sample(2000)
        await SampleStorage.get().save(blocker)
        const entry = sample(1000)
        disk.free = 100
        const handler = vi.fn(async () => {
            await SampleStorage.get().deleteItem(blocker.uuid)
            return true
        })
        installed.push(OpfsQuota.install(handler))
        await SampleStorage.get().save(entry)
        expect(handler).toHaveBeenCalledOnce()
        expect(filesOf(entry.uuid)).toEqual(["audio.wav", "meta.json", "peaks.bin"])
        expect(disk.files.get(`${folderOf(entry.uuid)}/audio.wav`)?.length).toBe(44 + 1000 * 4)
        expect(JSON.parse(new TextDecoder().decode(disk.files.get(`${folderOf(entry.uuid)}/meta.json`)))).toEqual(entry.meta)
    })

    it("never runs two saves at once, even when they are started together", async () => {
        const entries = Array.from({length: 6}, () => sample(200))
        await Promise.all(entries.map(entry => SampleStorage.get().save(entry)))
        expect(disk.maxActive).toBe(1)
        entries.forEach(entry => expect(filesOf(entry.uuid)).toEqual(["audio.wav", "meta.json", "peaks.bin"]))
    })

    it("keeps samples and soundfonts in one queue", async () => {
        const meta = {name: "Piano", size: 4, url: "", license: "", origin: "openDAW" as const}
        await Promise.all([
            SampleStorage.get().save(sample(200)),
            SoundfontStorage.get().save({uuid: UUID.generate(), file: new Uint8Array(400).buffer, meta}),
            SampleStorage.get().save(sample(200))
        ])
        expect(disk.maxActive).toBe(1)
    })

    it("goes on with the next save after one failed", async () => {
        const failing = sample(1000)
        const next = sample(10)
        disk.free = 200
        const results = await Promise.allSettled([SampleStorage.get().save(failing), SampleStorage.get().save(next)])
        expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"])
        expect(filesOf(next.uuid)).toEqual(["audio.wav", "meta.json", "peaks.bin"])
    })

    it("never writes two saves at once while the handler makes room", async () => {
        const blocker = sample(2000)
        await SampleStorage.get().save(blocker)
        disk.free = 100
        disk.maxActive = 0
        installed.push(OpfsQuota.install(async () => {
            await new Promise(resolve => setTimeout(resolve, 5))
            await SampleStorage.get().deleteItem(blocker.uuid)
            return true
        }))
        const first = sample(1000)
        const second = sample(10)
        await Promise.all([SampleStorage.get().save(first), SampleStorage.get().save(second)])
        expect(disk.maxActive).toBe(1)
        expect(filesOf(first.uuid)).toEqual(["audio.wav", "meta.json", "peaks.bin"])
        expect(filesOf(second.uuid)).toEqual(["audio.wav", "meta.json", "peaks.bin"])
    })

    it("does not retry updateMeta forever and leaves the error to the caller", async () => {
        const entry = sample(10)
        await SampleStorage.get().save(entry)
        disk.free = 0
        installed.push(OpfsQuota.install(async () => true))
        await expect(SampleStorage.get().updateSampleMeta(entry.uuid, {...entry.meta, name: "A much longer name"}))
            .rejects.toThrow("No space")
    })
})
