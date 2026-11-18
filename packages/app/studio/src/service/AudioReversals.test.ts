import {afterEach, describe, expect, it, vi} from "vitest"
import {AudioData, PPQN, SampleEffects, WavFile} from "@opendaw/lib-dsp"
import {EmptyExec, isDefined, Option, panic, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {AudioClipBoxAdapter, AudioRegionBoxAdapter, ProjectSkeleton, SampleLoaderManager, TrackType} from "@opendaw/studio-adapters"
import {
    AudioClipBox, AudioFileBox, AudioRegionBox, AudioTimeStretchBox, TrackBox, ValueEventCollectionBox, WarpMarkerBox
} from "@opendaw/studio-boxes"
import type {Project as ProjectType, ProjectEnv, SampleService} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"

vi.mock("@opendaw/studio-core", async importOriginal => ({
    ...await importOriginal<typeof import("@opendaw/studio-core")>(),
    Workers: {
        SampleEffect: {process: async (...[progress, id, source, values]:
            Parameters<import("@opendaw/lib-dsp").SampleEffectProtocol["process"]>) =>
            SampleEffects.byId(id).unwrap("effect").process(source, values, progress)},
        Transients: {detect: async () => []}
    }
}))

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const {AudioReversals} = await import("./AudioReversals")
const {Project, SampleGarbage} = await import("@opendaw/studio-core")

const environment = (audio: AudioData): ProjectEnv => {
    const sampleManager: SampleLoaderManager = {
        getOrCreate: uuid => ({
            uuid, data: Option.wrap(audio), peaks: Option.None, meta: Option.None,
            state: {type: "loaded"}, invalidate: EmptyExec, subscribe: () => Terminable.Empty,
            acquire: async () => ({data: audio, terminate: EmptyExec})
        }),
        record: EmptyExec, invalidate: EmptyExec, remove: EmptyExec, register: () => Terminable.Empty
    }
    return {
        sampleManager,
        get audioContext() {return panic("Unexpected AudioContext access")},
        get audioWorklets() {return panic("Unexpected AudioWorklets access")},
        get soundfontManager() {return panic("Unexpected SoundfontManager access")},
        get sampleService() {return panic("Unexpected SampleService access")},
        get soundfontService() {return panic("Unexpected SoundfontService access")}
    }
}

// Stand-in for the three StudioService members reverse() reads.
const studioService = (project: ProjectType, importFile: SampleService["importFile"]): StudioService =>
    Object.create(null, {
        project: {value: project},
        optProject: {value: Option.wrap(project)},
        sampleService: {value: {importFile}}
    })

const importInto = (outputs: Array<AudioData>) => vi.fn<SampleService["importFile"]>(async args => {
    const output = WavFile.decodeFloats(args.arrayBuffer)
    outputs.push(output)
    return {
        uuid: UUID.toString(args.uuid ?? UUID.generate()), name: args.name ?? "Sample", bpm: args.bpm ?? 0,
        duration: output.numberOfFrames / output.sampleRate, sample_rate: output.sampleRate, origin: "import"
    }
})

afterEach(() => vi.restoreAllMocks())

describe("Reverse Audio", () => {
    it("reverses only the trimmed range, leaves a shared source intact and supports undo and redo", async () => {
        const closeProgress = vi.fn()
        const showProgress = vi.spyOn(RuntimeNotifier, "progress").mockReturnValue({
            message: "", terminate: closeProgress
        })
        const audio = AudioData.create(48000, 8, 2)
        audio.frames[0].set([1, 2, 3, 4, 5, 6, 7, 8])
        audio.frames[1].set([-1, -2, -3, -4, -5, -6, -7, -8])
        vi.spyOn(SampleGarbage, "mark").mockResolvedValue()
        vi.spyOn(SampleGarbage, "unmark").mockResolvedValue()
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(environment(audio), skeleton)
        const {boxGraph, editing, primaryAudioUnitBox} = project
        const pulsesPerFrame = PPQN.secondsToPulses(1 / audio.sampleRate, 120)
        const {source, selected, sibling, clip} = editing.modify(() => {
            const track = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Audio)
                box.tracks.refer(primaryAudioUnitBox.tracks)
                box.target.refer(primaryAudioUnitBox)
            })
            const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
            const source = AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue("Source"))
            const createRegion = (position: number) => AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.file.refer(source)
                box.regions.refer(track.regions)
                box.events.refer(events.owners)
                box.position.setValue(position)
                box.duration.setValue(pulsesPerFrame * 4)
                box.loopDuration.setValue(pulsesPerFrame * 8)
                box.loopOffset.setValue(pulsesPerFrame * 2)
            })
            const clip = AudioClipBox.create(boxGraph, UUID.generate(), box => {
                box.file.refer(source)
                box.clips.refer(track.clips)
                box.events.refer(events.owners)
                box.duration.setValue(pulsesPerFrame * 4)
                box.waveformOffset.setValue(2 / audio.sampleRate)
            })
            return {source, selected: createRegion(0), sibling: createRegion(PPQN.Bar), clip}
        }).unwrap("test regions")
        const item = project.boxAdapters.adapterFor(selected, AudioRegionBoxAdapter)
        const launcher = project.boxAdapters.adapterFor(clip, AudioClipBoxAdapter)
        const outputs: Array<AudioData> = []
        const importFile = importInto(outputs)
        const service = studioService(project, importFile)
        await AudioReversals.reverse(service, [item, launcher])
        expect(importFile).toHaveBeenCalledTimes(1)
        expect(showProgress).toHaveBeenCalledTimes(1)
        expect(showProgress).toHaveBeenCalledWith({headline: "Reversing Audio...", delayed: true})
        expect(closeProgress).toHaveBeenCalledTimes(1)
        const output = outputs[0]
        expect(Array.from(output.frames[0])).toEqual([1, 2, 6, 5, 4, 3, 7, 8])
        expect(Array.from(output.frames[1])).toEqual([-1, -2, -6, -5, -4, -3, -7, -8])
        const sourceOf = (box: AudioRegionBox | AudioClipBox) => box.file.targetVertex.unwrap("source").box
        const reversed = sourceOf(selected)
        expect(reversed).not.toBe(source)
        expect(sourceOf(clip)).toBe(reversed)
        expect(sourceOf(sibling)).toBe(source)
        expect(Array.from(audio.frames[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        expect(editing.undo()).toBe(true)
        expect(sourceOf(selected)).toBe(source)
        expect(sourceOf(clip)).toBe(source)
        expect(editing.redo()).toBe(true)
        expect(sourceOf(selected).address.equals(reversed.address)).toBe(true)
        expect(sourceOf(clip).address.equals(reversed.address)).toBe(true)
        expect(sourceOf(sibling)).toBe(source)
        await AudioReversals.reverse(service, [item])
        expect(closeProgress).toHaveBeenCalledTimes(2)
        const beforeFailure = sourceOf(selected)
        vi.mocked(SampleGarbage.mark).mockClear()
        const failure = new Error("Cannot apply reverse edit")
        vi.spyOn(editing, "modify").mockImplementationOnce(() => {throw failure})
        await expect(AudioReversals.reverse(service, [item])).rejects.toBe(failure)
        expect(SampleGarbage.mark).toHaveBeenCalledTimes(1)
        expect(SampleGarbage.mark).toHaveBeenCalledWith(importFile.mock.calls[2][0].uuid)
        expect(sourceOf(selected)).toBe(beforeFailure)
        project.terminate()
    })

    it("mirrors warp markers inside the reversed range so each segment keeps its stretch", async () => {
        vi.spyOn(RuntimeNotifier, "progress").mockReturnValue({message: "", terminate: EmptyExec})
        vi.spyOn(SampleGarbage, "mark").mockResolvedValue()
        vi.spyOn(SampleGarbage, "unmark").mockResolvedValue()
        const audio = AudioData.create(48000, 8, 1)
        audio.frames[0].set([1, 2, 3, 4, 5, 6, 7, 8])
        const frame = 1 / audio.sampleRate
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const project = Project.fromSkeleton(environment(audio), skeleton)
        const {boxGraph, editing, primaryAudioUnitBox} = project
        const region = editing.modify(() => {
            const track = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Audio)
                box.tracks.refer(primaryAudioUnitBox.tracks)
                box.target.refer(primaryAudioUnitBox)
            })
            const stretch = AudioTimeStretchBox.create(boxGraph, UUID.generate())
            const markers: ReadonlyArray<[number, number]> = [[0, 0], [100, 6 * frame], [400, 8 * frame]]
            markers.forEach(([position, seconds]) => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
                box.owner.refer(stretch.warpMarkers)
                box.position.setValue(position)
                box.seconds.setValue(seconds)
            }))
            const source = AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue("Source"))
            const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
            return AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                box.file.refer(source)
                box.regions.refer(track.regions)
                box.events.refer(events.owners)
                box.playMode.refer(stretch)
                box.duration.setValue(400)
                box.loopDuration.setValue(400)
            })
        }).unwrap("test region")
        const item = project.boxAdapters.adapterFor(region, AudioRegionBoxAdapter)
        const warpMarkers = () => item.optWarpMarkers.unwrap("warp markers").asArray()
            .map(({position, seconds}) => [position, Math.round(seconds / frame)])
        const outputs: Array<AudioData> = []
        await AudioReversals.reverse(studioService(project, importInto(outputs)), [item])
        expect(Array.from(outputs[0].frames[0])).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
        expect(warpMarkers()).toEqual([[0, 0], [300, 2], [400, 8]])
        expect(editing.undo()).toBe(true)
        expect(warpMarkers()).toEqual([[0, 0], [100, 6], [400, 8]])
        expect(region.file.targetVertex.map(vertex => vertex.box.name).unwrap("file")).toBe("AudioFileBox")
        project.terminate()
    })
})
