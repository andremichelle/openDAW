import {describe, expect, it, vi} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, PPQN} from "@opendaw/lib-dsp"
import {InstrumentFactories, ProjectSkeleton, Sample} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, NanoDeviceBox, TransientMarkerBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./project/ProjectEnv"
import type {Project} from "./project/Project"

const files = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock("./Workers", () => ({
    Workers: {
        Opfs: {
            exists: async (path: string) =>
                Array.from(files.keys()).some(key => key === path || key.startsWith(`${path}/`)),
            read: async (path: string) => {
                const bytes = files.get(path)
                if (bytes === undefined) {throw new Error(`NotFound ${path}`)}
                return bytes
            },
            write: async (path: string, bytes: Uint8Array) => {files.set(path, bytes.slice())},
            delete: async (path: string) => {
                Array.from(files.keys()).filter(key => key === path || key.startsWith(`${path}/`))
                    .forEach(key => files.delete(key))
            },
            list: async (folder: string) => Array.from(files.keys())
                .filter(path => path.startsWith(`${folder}/`))
                .map(path => path.substring(folder.length + 1).split("/"))
                .map(segments => ({name: segments[0], kind: segments.length > 1 ? "directory" : "file"}))
                .filter((entry, index, all) => all.findIndex(other => other.name === entry.name) === index)
        }
    }
}))

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const {AudioMonoConversion} = await import("./AudioMonoConversion")
const {SampleGarbage} = await import("./samples/SampleGarbage")
const {SampleStorage} = await import("./samples/SampleStorage")
const {AudioContentFactory} = await import("./project/audio/AudioContentFactory")

const createEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get meta() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const createProject = async (): Promise<Project> => {
    const {Project} = await import("./project/Project")
    return Project.fromSkeleton(createEnv(), ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
}

const createSample = (): Sample => ({
    uuid: UUID.toString(UUID.generate()), name: "Vox", bpm: 120, duration: 2, sample_rate: 48000, origin: "import"
})

const storeSample = (uuid: UUID.Bytes): void => {
    files.set(`${SampleStorage.Folder}/${UUID.toString(uuid)}/meta.json`, new TextEncoder().encode("{}"))
}

const isStored = (uuid: UUID.Bytes): boolean =>
    files.has(`${SampleStorage.Folder}/${UUID.toString(uuid)}/meta.json`)

type Setup = {
    project: Project
    original: AudioFileBox
    regions: ReadonlyArray<AudioRegionBox>
    nano: NanoDeviceBox
}

const setup = async (): Promise<Setup> => {
    files.clear()
    const project = await createProject()
    const sample = createSample()
    const {original, regions, nano} = project.editing.modify(() => {
        const {boxGraph} = project
        const {trackBox} = project.api.createInstrument(InstrumentFactories.Tape)
        const original = AudioFileBox.create(boxGraph, UUID.parse(sample.uuid), box => {
            box.fileName.setValue("Vox")
            box.endInSeconds.setValue(2)
        })
        ;[0.25, 0.75].forEach(position => TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(original.transientMarkers)
            box.position.setValue(position)
        }))
        const regions = [0, PPQN.Bar * 2].map(position => AudioContentFactory.createNotStretchedRegion({
            boxGraph, targetTrack: trackBox, audioFileBox: original, sample, position, name: "Vox"
        }))
        const {instrumentBox} = project.api.createInstrument(InstrumentFactories.Nano)
        const nano = instrumentBox as NanoDeviceBox
        nano.file.refer(original)
        return {original, regions, nano}
    }).unwrap("setup")
    return {project, original, regions, nano}
}

const fileOf = (region: AudioRegionBox): Option<AudioFileBox> =>
    region.file.targetVertex.map(vertex => vertex.box as AudioFileBox)

describe("AudioMonoConversion.mixdown", () => {
    const stereo = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): AudioData => {
        const audioData = AudioData.create(48000, left.length, 2)
        audioData.frames[0].set(left)
        audioData.frames[1].set(right)
        return audioData
    }

    it("sums the channels at full level", () => {
        const mono = AudioMonoConversion.mixdown(stereo([0.25, -0.5, 1.0], [0.5, 0.25, 1.0]), "sum")
        expect(mono.numberOfChannels).toBe(1)
        expect(mono.numberOfFrames).toBe(3)
        expect(mono.sampleRate).toBe(48000)
        expect(Array.from(mono.frames[0])).toStrictEqual([0.75, -0.25, 2.0])
    })

    it("sums the channels at equal power", () => {
        const mono = AudioMonoConversion.mixdown(stereo([0.25, -0.5, 1.0], [0.5, 0.25, 1.0]), "equal-power")
        const expected = [0.75, -0.25, 2.0].map(value => value * Math.SQRT1_2)
        Array.from(mono.frames[0]).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6))
    })

    it("keeps silence silent and an empty file empty", () => {
        expect(Array.from(AudioMonoConversion.mixdown(stereo([0, 0], [0, 0]), "sum").frames[0])).toStrictEqual([0, 0])
        expect(AudioMonoConversion.mixdown(stereo([], []), "equal-power").numberOfFrames).toBe(0)
    })

    it("cancels out phase inverted channels when summed", () => {
        const mono = AudioMonoConversion.mixdown(stereo([0.5, -0.25], [-0.5, 0.25]), "sum")
        expect(Array.from(mono.frames[0])).toStrictEqual([0, 0])
    })
})

describe("AudioMonoConversion.replace", () => {
    it("points every region and device at the mono file and deletes the original", async () => {
        const {project, original, regions, nano} = await setup()
        const originalUuid = original.address.uuid
        const monoUuid = UUID.generate()
        const mono = project.editing.modify(() =>
            AudioMonoConversion.replace(project, original, monoUuid, false)).unwrap("replace")
        expect(project.boxGraph.findBox(originalUuid).isEmpty()).toBe(true)
        regions.forEach(region => expect(fileOf(region).unwrap().address.toString()).toBe(mono.address.toString()))
        expect(nano.file.targetVertex.unwrap().box.address.toString()).toBe(mono.address.toString())
        expect(mono.fileName.getValue()).toBe("Vox")
        expect(mono.endInSeconds.getValue()).toBe(2)
        const positions = mono.transientMarkers.pointerHub.incoming()
            .map(pointer => (pointer.box as TransientMarkerBox).position.getValue())
            .toSorted((a, b) => a - b)
        expect(positions).toStrictEqual([0.25, 0.75])
    })

    it("restores the original for every user on undo and the mono file again on redo", async () => {
        const {project, original, regions, nano} = await setup()
        const originalAddress = original.address.toString()
        const monoUuid = UUID.generate()
        project.editing.modify(() => AudioMonoConversion.replace(project, original, monoUuid, false))
        project.editing.undo()
        expect(project.boxGraph.findBox(monoUuid).isEmpty()).toBe(true)
        regions.forEach(region => expect(fileOf(region).unwrap().address.toString()).toBe(originalAddress))
        expect(nano.file.targetVertex.unwrap().box.address.toString()).toBe(originalAddress)
        project.editing.redo()
        regions.forEach(region => expect(UUID.equals(fileOf(region).unwrap().address.uuid, monoUuid)).toBe(true))
        expect(UUID.equals(nano.file.targetVertex.unwrap().box.address.uuid, monoUuid)).toBe(true)
    })

    it("reuses a mono file that already exists in the project", async () => {
        const {project, original, regions} = await setup()
        const monoUuid = UUID.generate()
        const [existing, mono] = project.editing.modify(() => {
            const existing = AudioFileBox.create(project.boxGraph, monoUuid, box => box.fileName.setValue("Existing"))
            return [existing, AudioMonoConversion.replace(project, original, monoUuid, false)]
        }).unwrap("replace")
        expect(mono).toBe(existing)
        expect(existing.fileName.getValue()).toBe("Existing")
        regions.forEach(region => expect(fileOf(region).unwrap()).toBe(existing))
    })
})

describe("SampleGarbage", () => {
    it("marks the original after the conversion, unless it is kept", async () => {
        const {project, original} = await setup()
        const originalId = UUID.toString(original.address.uuid)
        project.editing.modify(() => AudioMonoConversion.replace(project, original, UUID.generate(), false))
        expect(await SampleGarbage.list()).toStrictEqual([originalId])
        const kept = await setup()
        kept.project.editing.modify(() =>
            AudioMonoConversion.replace(kept.project, kept.original, UUID.generate(), true))
        expect(await SampleGarbage.list()).toStrictEqual([])
    })

    it("swaps the marks on undo and redo", async () => {
        const {project, original} = await setup()
        const originalId = UUID.toString(original.address.uuid)
        const monoUuid = UUID.generate()
        const monoId = UUID.toString(monoUuid)
        project.editing.modify(() => AudioMonoConversion.replace(project, original, monoUuid, false))
        project.editing.undo()
        expect(await SampleGarbage.list()).toStrictEqual([monoId])
        project.editing.redo()
        expect(await SampleGarbage.list()).toStrictEqual([originalId])
    })

    it("marks a deleted user created sample and unmarks it when undo brings it back", async () => {
        const {project, original, regions, nano} = await setup()
        const id = UUID.toString(original.address.uuid)
        project.trackUserCreatedSample(original.address.uuid)
        project.editing.modify(() => {
            regions.forEach(region => region.delete())
            nano.file.defer()
            original.delete()
        })
        expect(await SampleGarbage.list()).toStrictEqual([id])
        project.editing.undo()
        expect(await SampleGarbage.list()).toStrictEqual([])
    })

    it("ignores samples that were not created by the user", async () => {
        const {project, original, regions, nano} = await setup()
        project.editing.modify(() => {
            regions.forEach(region => region.delete())
            nano.file.defer()
            original.delete()
        })
        expect(await SampleGarbage.list()).toStrictEqual([])
    })

    it("purges marked samples from storage and clears the list", async () => {
        files.clear()
        const garbage = UUID.generate()
        const other = UUID.generate()
        storeSample(garbage)
        storeSample(other)
        await SampleGarbage.mark(garbage)
        expect(await SampleGarbage.purge()).toStrictEqual([UUID.toString(garbage)])
        expect(isStored(garbage)).toBe(false)
        expect(isStored(other)).toBe(true)
        expect(await SampleGarbage.list()).toStrictEqual([])
    })

    it("keeps marked samples that are still in use and drops them from the list", async () => {
        files.clear()
        const garbage = UUID.generate()
        storeSample(garbage)
        await SampleGarbage.mark(garbage)
        expect(await SampleGarbage.purge([UUID.toString(garbage)])).toStrictEqual([])
        expect(isStored(garbage)).toBe(true)
        expect(await SampleGarbage.list()).toStrictEqual([])
    })

    it("marks once, unmarks only what is marked and treats a missing sample as gone", async () => {
        files.clear()
        const uuid = UUID.generate()
        await SampleGarbage.mark(uuid)
        await SampleGarbage.mark(uuid)
        expect(await SampleGarbage.list()).toStrictEqual([UUID.toString(uuid)])
        await SampleGarbage.unmark(UUID.generate())
        expect(await SampleGarbage.list()).toStrictEqual([UUID.toString(uuid)])
        expect(await SampleGarbage.purge()).toStrictEqual([])
        expect(await SampleGarbage.list()).toStrictEqual([])
    })

    it("does nothing when the list is empty", async () => {
        files.clear()
        expect(await SampleGarbage.purge()).toStrictEqual([])
    })
})
