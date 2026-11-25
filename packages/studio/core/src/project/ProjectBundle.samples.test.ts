// @vitest-environment node
import {afterEach, describe, expect, it, vi} from "vitest"
import JSZip from "jszip"
import {asDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {AudioClipBox, AudioFileBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, SampleMetaData, TrackType} from "@opendaw/studio-adapters"

// a library sample is ready before its background save is done, or when that save failed on a full disk
const files = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock("../Workers", () => ({
    Workers: {
        Opfs: {
            exists: async (path: string) => files.has(path),
            read: async (path: string) => {
                const bytes = files.get(path)
                if (bytes === undefined) {throw new DOMException(`${path} not found`, "NotFoundError")}
                return bytes
            },
            write: async (path: string, bytes: Uint8Array) => {files.set(path, bytes.slice())}
        },
        Peak: {generateAsync: async () => new Uint8Array([9, 9, 9]).buffer}
    }
}))

import type {ProjectEnv} from "./ProjectEnv"
import {ProjectBundle} from "./ProjectBundle"
import {ProjectProfile} from "./ProjectProfile"
import {ProjectMeta} from "./ProjectMeta"

const meta: SampleMetaData = {name: "Kick", bpm: 0, duration: 0.01, sample_rate: 48000, origin: "openDAW"}
const sampleUuid = UUID.generate()
const audio = (): AudioData => {
    const data = AudioData.create(48000, 480, 1)
    data.frames[0].fill(0.25)
    return data
}

const createProfile = async (data: AudioData): Promise<ProjectProfile> => {
    const {Project} = await import("./Project")
    const env = {
        audioContext: undefined, audioWorklets: undefined,
        sampleManager: {
            getOrCreate: (uuid: UUID.Bytes) => ({
                get data() {return Option.wrap(data)},
                get peaks() {return Option.None},
                get meta() {return Option.wrap(meta)},
                get uuid() {return uuid},
                get state() {return {type: "loaded"} as const},
                invalidate() {},
                subscribe: () => Terminable.Empty
            }),
            record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
        },
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as ProjectEnv
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(env, skeleton)
    const {boxGraph} = project
    const {primaryAudioUnitBox} = skeleton.mandatoryBoxes
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const fileBox = AudioFileBox.create(boxGraph, sampleUuid, box => box.fileName.setValue("Kick"))
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioClipBox.create(boxGraph, UUID.generate(), box => {
        box.clips.refer(trackBox.clips)
        box.file.refer(fileBox)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    return new ProjectProfile(UUID.generate(), project, ProjectMeta.init(), Option.None)
}
const sampleEntries = async (bundle: ArrayBuffer) => {
    const zip = await JSZip.loadAsync(bundle)
    const folder = `samples/${UUID.toString(sampleUuid)}`
    return {
        names: Object.keys(zip.files).filter(path => path.startsWith(`${folder}/`) && !path.endsWith("/")).sort(),
        meta: JSON.parse(await asDefined(zip.file(`${folder}/meta.json`)).async("text")),
        peaks: Array.from(await asDefined(zip.file(`${folder}/peaks.bin`)).async("uint8array"))
    }
}

describe("ProjectBundle with samples", () => {
    afterEach(() => files.clear())

    it("exports a loaded sample that is not stored yet from memory", async () => {
        const bundle = await ProjectBundle.encode(await createProfile(audio()), () => {})
        const {names, meta: exported, peaks} = await sampleEntries(bundle)
        const folder = `samples/${UUID.toString(sampleUuid)}`
        expect(names).toEqual([`${folder}/audio.wav`, `${folder}/meta.json`, `${folder}/peaks.bin`])
        expect(exported).toEqual(meta)
        expect(peaks).toEqual([9, 9, 9])
    })

    it("exports the stored files once the sample is stored", async () => {
        const path = `samples/v2/${UUID.toString(sampleUuid)}`
        files.set(`${path}/audio.wav`, new Uint8Array([1, 2]))
        files.set(`${path}/peaks.bin`, new Uint8Array([3]))
        files.set(`${path}/meta.json`, new TextEncoder().encode(JSON.stringify({...meta, name: "Stored"})))
        const bundle = await ProjectBundle.encode(await createProfile(audio()), () => {})
        const {meta: exported, peaks} = await sampleEntries(bundle)
        expect(exported.name).toBe("Stored")
        expect(peaks).toEqual([3])
    })
})
