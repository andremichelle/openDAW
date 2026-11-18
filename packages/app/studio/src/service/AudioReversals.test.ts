import {afterEach, describe, expect, it, vi} from "vitest"
import {AudioData, PPQN, SampleEffects, WavFile} from "@opendaw/lib-dsp"
import {EmptyExec, isDefined, Option, panic, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {AudioClipBoxAdapter, AudioRegionBoxAdapter, ProjectSkeleton, SampleLoaderManager, TrackType} from "@opendaw/studio-adapters"
import {AudioClipBox, AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "@opendaw/studio-core"

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

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("Reverse Audio", () => {
    it("reverses only the trimmed range, leaves a shared source intact and supports undo and redo", async () => {
        vi.useFakeTimers()
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
        const importFile = vi.fn<import("@opendaw/studio-core").SampleService["importFile"]>(async args => {
            const output = WavFile.decodeFloats(args.arrayBuffer)
            outputs.push(output)
            return {
                uuid: UUID.toString(args.uuid ?? UUID.generate()), name: args.name ?? "Sample", bpm: args.bpm ?? 0,
                duration: output.numberOfFrames / output.sampleRate, sample_rate: output.sampleRate, origin: "import"
            }
        })
        const service: import("./AudioReversals").AudioReversals.Context = {
            project, optProject: Option.wrap(project), sampleService: {importFile}
        }
        await AudioReversals.reverse(service, [item, launcher])
        expect(importFile).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(500)
        expect(showProgress).not.toHaveBeenCalled()
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
        const slowImport = Promise.withResolvers<void>()
        importFile.mockImplementationOnce(async args => {
            await slowImport.promise
            return {
                uuid: UUID.toString(args.uuid ?? UUID.generate()), name: args.name ?? "Sample", bpm: args.bpm ?? 0,
                duration: audio.numberOfFrames / audio.sampleRate, sample_rate: audio.sampleRate, origin: "import"
            }
        })
        const slowReverse = AudioReversals.reverse(service, [item])
        await vi.advanceTimersByTimeAsync(499)
        expect(showProgress).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(showProgress).toHaveBeenCalledTimes(1)
        slowImport.resolve()
        await slowReverse
        expect(closeProgress).toHaveBeenCalledTimes(1)
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
})
