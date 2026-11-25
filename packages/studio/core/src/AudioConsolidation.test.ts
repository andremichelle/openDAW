import {beforeEach, describe, expect, it, vi} from "vitest"
import {isDefined, Option, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, PPQN} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, InstrumentFactories, ProjectSkeleton, Sample} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./project/ProjectEnv"
import type {Project} from "./project/Project"
import type {SampleService} from "./samples/SampleService"

const transients = vi.hoisted(() => ({
    detect: vi.fn<(audioData: unknown) => Promise<ReadonlyArray<number>>>()
}))

vi.mock("./Workers", () => ({Workers: {Transients: transients}}))

vi.mock("./OfflineEngineRenderer", () => ({
    OfflineEngineRenderer: {
        create: async () => ({
            waitForLoading: async () => {},
            setPosition: () => {},
            play: () => {},
            step: async (numSamples: number) => [new Float32Array(numSamples), new Float32Array(numSamples)],
            terminate: () => {}
        })
    }
}))

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

type Dialog = { cancel: Option<() => void>, closed: boolean }
const dialogs: Array<Dialog> = []
RuntimeNotifier.install({
    info: async () => {},
    approve: async () => true,
    progress: request => {
        const dialog: Dialog = {cancel: Option.wrap(request.cancel ?? null), closed: false}
        dialogs.push(dialog)
        return {set message(_: string) {}, terminate: () => {dialog.closed = true}}
    },
    notify: () => {}
})

const {AudioConsolidation} = await import("./AudioConsolidation")
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

const createSample = (name: string): Sample => ({
    uuid: UUID.toString(UUID.generate()), name, bpm: 120, duration: 2, sample_rate: 48000, origin: "import"
})

const createSampleService = (): SampleService => ({
    audioContext: {sampleRate: 48000},
    importFile: async ({name}: { name: string }) => createSample(name)
}) as unknown as SampleService

type Setup = { project: Project, trackBox: TrackBox, regions: ReadonlyArray<AudioRegionBoxAdapter> }

const setup = async (): Promise<Setup> => {
    const {Project} = await import("./project/Project")
    const project = Project.fromSkeleton(createEnv(),
        ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
    const sample = createSample("Vox")
    const {trackBox, boxes} = project.editing.modify(() => {
        const {boxGraph} = project
        const {trackBox} = project.api.createInstrument(InstrumentFactories.Tape)
        const audioFileBox = AudioFileBox.create(boxGraph, UUID.parse(sample.uuid), box => {
            box.fileName.setValue("Vox")
            box.endInSeconds.setValue(2)
        })
        const boxes = [0, PPQN.Bar].map(position => AudioContentFactory.createNotStretchedRegion({
            boxGraph, targetTrack: trackBox, audioFileBox, sample, position, name: "Vox"
        }))
        return {trackBox, boxes}
    }).unwrap("setup")
    const regions = boxes.map(box => project.boxAdapters.adapterFor(box, AudioRegionBoxAdapter))
    return {project, trackBox, regions}
}

const regionsOf = (trackBox: TrackBox): ReadonlyArray<AudioRegionBox> =>
    trackBox.regions.pointerHub.incoming().map(pointer => pointer.box as AudioRegionBox)

const pendingTransients = (): { release: () => void } => {
    const {promise, resolve} = Promise.withResolvers<ReadonlyArray<number>>()
    transients.detect.mockReturnValueOnce(promise)
    return {release: () => resolve([])}
}

describe("AudioConsolidation.flatten", () => {
    beforeEach(() => {
        dialogs.length = 0
        transients.detect.mockReset()
    })

    it("keeps the progress dialog open while the transients are detected", async () => {
        const {project, trackBox, regions} = await setup()
        const {release} = pendingTransients()
        const flattening = AudioConsolidation.flatten(project, createSampleService(), regions)
        await vi.waitFor(() => expect(transients.detect).toHaveBeenCalled())
        expect(dialogs.some(dialog => !dialog.closed)).toBe(true)
        release()
        await flattening
        expect(dialogs.every(dialog => dialog.closed)).toBe(true)
        expect(regionsOf(trackBox).length).toBe(1)
    })

    it("flattens without the region deleted while the transients are detected", async () => {
        const {project, trackBox, regions} = await setup()
        const {release} = pendingTransients()
        const flattening = AudioConsolidation.flatten(project, createSampleService(), regions)
        await vi.waitFor(() => expect(transients.detect).toHaveBeenCalled())
        project.editing.modify(() => regions[1].box.delete())
        release()
        await expect(flattening).resolves.toBeUndefined()
        const remaining = regionsOf(trackBox)
        expect(remaining.length).toBe(1)
        expect(remaining[0].label.getValue()).toBe("Vox")
        expect(regions.some(region => region.box.isAttached())).toBe(false)
    })

    it("creates nothing when the track is deleted while the transients are detected", async () => {
        const {project, trackBox, regions} = await setup()
        const {release} = pendingTransients()
        const flattening = AudioConsolidation.flatten(project, createSampleService(), regions)
        await vi.waitFor(() => expect(transients.detect).toHaveBeenCalled())
        project.editing.modify(() => trackBox.delete())
        release()
        await expect(flattening).resolves.toBeUndefined()
        expect(project.boxGraph.boxes().some(box => box instanceof AudioRegionBox)).toBe(false)
    })

    it("closes the dialog and keeps the regions when the transient detection fails", async () => {
        const {project, trackBox, regions} = await setup()
        transients.detect.mockRejectedValueOnce(new Error("worker gone"))
        await expect(AudioConsolidation.flatten(project, createSampleService(), regions)).resolves.toBeUndefined()
        expect(dialogs.every(dialog => dialog.closed)).toBe(true)
        expect(regionsOf(trackBox).length).toBe(2)
    })

    it("leaves the regions untouched when cancelled while the transients are detected", async () => {
        const {project, trackBox, regions} = await setup()
        const {release} = pendingTransients()
        const flattening = AudioConsolidation.flatten(project, createSampleService(), regions)
        await vi.waitFor(() => expect(transients.detect).toHaveBeenCalled())
        dialogs.forEach(dialog => dialog.cancel.ifSome(cancel => cancel()))
        release()
        await flattening
        expect(regionsOf(trackBox).map(box => box.address.toString()))
            .toStrictEqual(regions.map(region => region.box.address.toString()))
    })
})
