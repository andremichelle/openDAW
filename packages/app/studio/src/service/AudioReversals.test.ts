import {describe, expect, it, vi} from "vitest"
import {BoxEditing} from "@opendaw/lib-box"
import {AudioData, ConstantTempoMap, PPQN, SampleEffects, WavFile} from "@opendaw/lib-dsp"
import {DefaultObservableValue, isDefined, Option, UUID} from "@opendaw/lib-std"
import {AudioClipBoxAdapter, AudioRegionBoxAdapter, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {AudioClipBox, AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
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

describe("Reverse Audio", () => {
    it("reverses only the trimmed range, leaves a shared source intact and supports undo and redo", async () => {
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} =
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const editing = new BoxEditing(boxGraph)
        const tempoMap = new ConstantTempoMap(new DefaultObservableValue(120))
        const audio = AudioData.create(48000, 8, 2)
        audio.frames[0].set([1, 2, 3, 4, 5, 6, 7, 8])
        audio.frames[1].set([-1, -2, -3, -4, -5, -6, -7, -8])
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
        const file = {
            uuid: source.address.uuid, box: source, audioData: Promise.resolve(audio), fileName: "Source",
            getOrCreateLoader: () => ({meta: Option.None})
        }
        const item = {
            type: "audio-region", box: selected, optFile: Option.wrap(file), optWarpMarkers: Option.None,
            loopOffset: pulsesPerFrame * 2, duration: pulsesPerFrame * 4, loopDuration: pulsesPerFrame * 8,
            offset: -pulsesPerFrame * 2, waveformOffset: selected.waveformOffset
        } as unknown as AudioRegionBoxAdapter
        const launcher = {
            type: "audio-clip", box: clip, optFile: Option.wrap(file), optWarpMarkers: Option.None,
            duration: pulsesPerFrame * 4, waveformOffset: clip.waveformOffset
        } as unknown as AudioClipBoxAdapter
        const project = {boxGraph, editing, tempoMap, trackUserCreatedSample: vi.fn()}
        const importFile = vi.fn(async ({arrayBuffer}: {arrayBuffer: ArrayBuffer}) => WavFile.decodeFloats(arrayBuffer))
        const service = {project, optProject: Option.wrap(project), sampleService: {importFile}} as unknown as StudioService
        await AudioReversals.reverse(service, [item, launcher])
        expect(importFile).toHaveBeenCalledTimes(1)
        const output = await importFile.mock.results[0].value
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
    })
})
