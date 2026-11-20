// @vitest-environment node
// A bundle from a foreign site must not replace samples or soundfonts that are already stored.
import {afterEach, describe, expect, it, vi} from "vitest"
import JSZip from "jszip"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

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
            write: async (path: string, bytes: Uint8Array) => {files.set(path, bytes.slice())}
        }
    }
}))

import type {ProjectEnv} from "./ProjectEnv"
import {ProjectBundle} from "./ProjectBundle"
import {ProjectProfile} from "./ProjectProfile"
import {ProjectMeta} from "./ProjectMeta"
import {SampleStorage} from "../samples"
import {SoundfontStorage} from "../soundfont/SoundfontStorage"

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const bundleWith = async (entries: Record<string, Uint8Array>): Promise<ArrayBuffer> => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const encoded = await ProjectBundle.encode(new ProjectProfile(UUID.generate(), project, ProjectMeta.init(), Option.None), () => {})
    const zip = await JSZip.loadAsync(encoded)
    Object.entries(entries).forEach(([path, bytes]) => zip.file(path, bytes))
    return zip.generateAsync({type: "arraybuffer"})
}

describe("ProjectBundle decode with stored samples", () => {
    afterEach(() => files.clear())

    it("keeps a stored sample file and adds the missing ones", async () => {
        const id = UUID.toString(UUID.generate())
        const stored = new Uint8Array([1, 2, 3])
        files.set(`${SampleStorage.Folder}/${id}/audio.bin`, stored)
        const bundle = await bundleWith({
            [`samples/${id}/audio.bin`]: new Uint8Array([9, 9, 9]),
            [`samples/${id}/peaks.bin`]: new Uint8Array([4, 5])
        })
        await ProjectBundle.decode(createEnv(), bundle)
        expect(Array.from(files.get(`${SampleStorage.Folder}/${id}/audio.bin`) ?? [])).toStrictEqual([1, 2, 3])
        expect(Array.from(files.get(`${SampleStorage.Folder}/${id}/peaks.bin`) ?? [])).toStrictEqual([4, 5])
    })

    it("keeps a stored soundfont file", async () => {
        const id = UUID.toString(UUID.generate())
        files.set(`${SoundfontStorage.Folder}/${id}/soundfont.sf2`, new Uint8Array([7]))
        const bundle = await bundleWith({[`soundfonts/${id}/soundfont.sf2`]: new Uint8Array([8])})
        await ProjectBundle.decode(createEnv(), bundle)
        expect(Array.from(files.get(`${SoundfontStorage.Folder}/${id}/soundfont.sf2`) ?? [])).toStrictEqual([7])
    })

    it("writes a sample that is not stored yet", async () => {
        const id = UUID.toString(UUID.generate())
        const bundle = await bundleWith({[`samples/${id}/audio.bin`]: new Uint8Array([6])})
        await ProjectBundle.decode(createEnv(), bundle)
        expect(Array.from(files.get(`${SampleStorage.Folder}/${id}/audio.bin`) ?? [])).toStrictEqual([6])
    })
})
