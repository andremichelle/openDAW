import {afterEach, describe, expect, it, vi} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {AudioClipBoxAdapter, ProjectSkeleton, Sample, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioClipBox, AudioFileBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {StudioService} from "@/service/StudioService"
import {CreateParameters} from "../TimelineDragAndDrop"
import {ClipCaptureTarget} from "./ClipCapturing"

// Live error 1168. Dropping a sample onto a clip slot whose clip is the ONLY user of that same sample:
// handleSample receives the (existing) AudioFileBox, deletes the slot's clip, and the deletion takes the
// AudioFileBox with it (mandatory target, last incoming pointer). The new clip then refers to a detached
// box: its pointer carries the address but never resolves, and AudioClipPainter panics "Cannot access file."

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const setup = async () => {
    const {Project} = await import("@opendaw/studio-core")
    const {ClipDragAndDrop} = await import("@/ui/timeline/tracks/audio-unit/clips/ClipDragAndDrop")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    const fileUuid = UUID.generate()
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const fileBox = AudioFileBox.create(boxGraph, fileUuid, box => {
        box.fileName.setValue("drop.wav")
        box.endInSeconds.setValue(4.0)
    })
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioClipBox.create(boxGraph, UUID.generate(), box => {
        box.index.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.clips.refer(trackBox.clips)
        box.file.refer(fileBox)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    const service = {project, timeline: {clips: {scroll: {getValue: () => 0}}}} as unknown as ConstructorParameters<typeof ClipDragAndDrop>[0]
    const capturing = {element: {getBoundingClientRect: () => ({left: 0})}} as unknown as
        ConstructorParameters<typeof ClipDragAndDrop>[1]
    const dragAndDrop = new ClipDragAndDrop(service, capturing)
    const trackBoxAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    const sample: Sample = {
        uuid: UUID.toString(fileUuid), name: "drop", bpm: 0, duration: 4.0, sample_rate: 48000, origin: "local"
    }
    return {boxGraph, fileBox, fileUuid, trackBox, dragAndDrop, trackBoxAdapter, sample}
}

describe("dropping a sample onto a clip slot (1168)", () => {
    it("keeps the AudioFileBox alive when the replaced clip was its only user", async () => {
        const {boxGraph, fileBox, dragAndDrop, trackBoxAdapter, sample} = await setup()
        boxGraph.beginTransaction()
        // the AudioFileBoxFactory returns the existing box for a known sample uuid
        dragAndDrop.handleSample({
            event: {clientX: 1} as DragEvent, trackBoxAdapter, audioFileBox: fileBox, sample, type: "sample"
        })
        boxGraph.endTransaction()
        const clip = trackBoxAdapter.clips.collection.getAdapterByIndex(0).unwrap("no clip at 0")
        expect(fileBox.isAttached()).toBe(true)
        expect((clip as AudioClipBoxAdapter).optFile.nonEmpty()).toBe(true)
    })
    it("still removes the replaced clip's file when a different sample is dropped", async () => {
        const {boxGraph, fileBox, dragAndDrop, trackBoxAdapter, sample} = await setup()
        const otherUuid = UUID.generate()
        boxGraph.beginTransaction()
        const otherFile = AudioFileBox.create(boxGraph, otherUuid, box => {
            box.fileName.setValue("other.wav")
            box.endInSeconds.setValue(2.0)
        })
        dragAndDrop.handleSample({
            event: {clientX: 1} as DragEvent, trackBoxAdapter, audioFileBox: otherFile,
            sample: {...sample, uuid: UUID.toString(otherUuid)}, type: "sample"
        })
        boxGraph.endTransaction()
        const clip = trackBoxAdapter.clips.collection.getAdapterByIndex(0).unwrap("no clip at 0")
        expect(fileBox.isAttached()).toBe(false)
        expect(otherFile.isAttached()).toBe(true)
        expect((clip as AudioClipBoxAdapter).optFile.nonEmpty()).toBe(true)
    })
})

describe("sample drops in a horizontally scrolled clip view", () => {
    afterEach(() => vi.restoreAllMocks())
    it.each(["file", "sample"] as const)("replaces the scrolled column for a %s drop", async type => {
        const {AudioContentFactory, ElementCapturing} = await import("@opendaw/studio-core")
        const {ClipDragAndDrop} = await import("./ClipDragAndDrop")
        const create = vi.spyOn(AudioContentFactory, type === "file"
            ? "createNotStretchedClip" : "createTimeStretchedClip")
            .mockReturnValue({} as ReturnType<typeof AudioContentFactory.createNotStretchedClip>)
        const earlierDelete = vi.fn()
        const targetDelete = vi.fn()
        const getAdapterByIndex = vi.fn((index: number) =>
            Option.wrap({box: {delete: index === 2 ? targetDelete : earlierDelete}}))
        const service = {
            project: {boxGraph: {}},
            timeline: {clips: {scroll: {getValue: () => 73.5}}}
        } as unknown as StudioService
        const capturing = {
            element: {getBoundingClientRect: () => ({left: 100})}
        } as unknown as InstanceType<typeof ElementCapturing<ClipCaptureTarget>>
        const drop = new ClipDragAndDrop(service, capturing)
        drop.handleSample({
            event: {clientX: 130}, trackBoxAdapter: {clips: {collection: {getAdapterByIndex}}},
            audioFileBox: {}, sample: {bpm: 120}, type
        } as unknown as CreateParameters)
        expect(getAdapterByIndex).toHaveBeenCalledWith(2)
        expect(targetDelete).toHaveBeenCalledOnce()
        expect(earlierDelete).not.toHaveBeenCalled()
        expect(create).toHaveBeenCalledWith(expect.objectContaining({index: 2}))
    })
})
