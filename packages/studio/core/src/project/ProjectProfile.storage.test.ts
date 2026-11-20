import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "./ProjectEnv"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

// a disk with a budget: a write that does not fit keeps the old bytes of a file, or leaves a new one empty
const disk = vi.hoisted(() => ({files: new Map<string, Uint8Array>(), free: Number.POSITIVE_INFINITY}))

vi.mock("../Workers", () => ({
    Workers: {
        Opfs: {
            write: async (path: string, bytes: Uint8Array) => {
                const previous = disk.files.get(path)?.length ?? 0
                if (bytes.length - previous > disk.free) {
                    if (previous === 0) {disk.files.set(path, new Uint8Array(0))}
                    throw new DOMException("No space available for this operation", "QuotaExceededError")
                }
                disk.free -= bytes.length - previous
                disk.files.set(path, bytes.slice())
            },
            exists: async (path: string) => Array.from(disk.files.keys()).some(key => key === path || key.startsWith(`${path}/`)),
            delete: async (path: string) => Array.from(disk.files.keys())
                .filter(key => key === path || key.startsWith(`${path}/`))
                .forEach(key => {
                    disk.free += disk.files.get(key)?.length ?? 0
                    disk.files.delete(key)
                })
        }
    }
}))

import {Project} from "./Project"
import {ProjectProfile} from "./ProjectProfile"
import {ProjectMeta} from "./ProjectMeta"
import {ProjectPaths} from "./ProjectPaths"

const createProfile = (saved: boolean) => {
    const sampleManager = {
        getOrCreate: () => ({data: Option.None, peaks: Option.None, subscribe: () => Terminable.Empty}),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    }
    const env = {
        audioContext: {currentTime: 0, sampleRate: 48000}, audioWorklets: undefined, sampleManager,
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as ProjectEnv
    const project = Project.fromSkeleton(env, ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    return new ProjectProfile(UUID.generate(), project, ProjectMeta.init("Song"), Option.None, saved)
}
const filesOf = (uuid: UUID.Bytes) => Array.from(disk.files.keys())
    .filter(path => path.startsWith(ProjectPaths.projectFolder(uuid)))

describe("ProjectProfile on a full disk", () => {
    beforeEach(() => {
        disk.files.clear()
        disk.free = Number.POSITIVE_INFINITY
        vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(console, "debug").mockImplementation(() => {})
    })
    afterEach(() => vi.restoreAllMocks())

    it("leaves nothing behind when the first save of a project does not fit", async () => {
        const profile = createProfile(false)
        disk.free = 10
        await expect(profile.saveAs(profile.meta)).rejects.toThrow("No space")
        expect(filesOf(profile.uuid)).toEqual([])
    })

    it("writes the meta file last", async () => {
        const profile = createProfile(false)
        await profile.saveAs(profile.meta)
        expect(Array.from(disk.files.keys()).filter(path => path.startsWith(ProjectPaths.projectFolder(profile.uuid))))
            .toEqual([ProjectPaths.projectFile(profile.uuid), ProjectPaths.projectMeta(profile.uuid)])
    })

    it("keeps the last save of a project when saving it again does not fit", async () => {
        const profile = createProfile(false)
        await profile.saveAs(profile.meta)
        const before = disk.files.get(ProjectPaths.projectFile(profile.uuid))
        profile.updateMetaData("name", "A much longer name than the one before")
        disk.free = 0
        await expect(profile.save()).rejects.toThrow("No space")
        expect(disk.files.get(ProjectPaths.projectFile(profile.uuid))).toEqual(before)
        expect(filesOf(profile.uuid).length).toBe(2)
    })
})
