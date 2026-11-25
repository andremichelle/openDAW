import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"

// Live error 1191: "regions overlap: prev.complete(32098.394561767578) > next.position(32098)".
// A start drag clamps a selected region's new start to the end of the selected region before it. A musical
// audio region's end is fractional (float32 duration), the start is an Int32 box field that truncates, so the
// clamped start lands 0.39 ppqn inside the neighbour. Live log: copy-drag (+30720) then a Ctrl start drag.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const FractionalLength: ppqn = 418.3945617675781 // live loopDuration (float32)
const PrevPosition: ppqn = 31680
const NextPosition: ppqn = 32160
const NextLength: ppqn = 2400

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const setup = async () => {
    // studio-core is imported HERE, after the AudioWorkletNode stub above: its barrel pulls
    // EngineWorklet, which extends AudioWorkletNode at class-definition time.
    const {Project, TimelineRange, RegionClipResolver} = await import("@opendaw/studio-core")
    const {Snapping} = await import("@/ui/timeline/Snapping.ts")
    const {RegionStartModifier} = await import("./RegionStartModifier.ts")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(60))
    const region = (position: ppqn, duration: ppqn) => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopDuration.setValue(FractionalLength)
            box.loopOffset.setValue(0)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
    }
    const prevBox = region(PrevPosition, FractionalLength)
    const nextBox = region(NextPosition, NextLength)
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as Parameters<typeof Project.fromSkeleton>[0], skeleton)
    const track = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    const prev = project.boxAdapters.adapterFor(prevBox, AudioRegionBoxAdapter)
    const next = project.boxAdapters.adapterFor(nextBox, AudioRegionBoxAdapter)
    prev.onSelected()
    next.onSelected()
    const range = new TimelineRange({padding: 0})
    range.maxUnits = PPQN.fromSignature(64, 4)
    range.width = 4096
    range.showAll()
    const snapping = new Snapping(range)
    snapping.index = 3 // 1/4
    const element = {getBoundingClientRect: () => ({left: 0})} as unknown as Element
    // Grabs `reference`'s start handle and drags it to `toPulse`, then releases.
    const dragStart = (reference: AudioRegionBoxAdapter, toPulse: ppqn, ctrlKey: boolean) => {
        const modifier = RegionStartModifier.create([prev, next], {
            project, element, snapping, pointerPulse: reference.position, reference
        }).unwrap("modifier")
        modifier.update({clientX: range.unitToX(toPulse), clientY: 0, altKey: false, shiftKey: false, ctrlKey})
        return modifier
    }
    return {project, track, prev, next, dragStart, RegionClipResolver}
}

describe("start drag clamped to a fractional neighbour end (#1191)", () => {
    it("the clamp asks for the first whole pulse after the neighbour end", async () => {
        const {project, prev, next, dragStart} = await setup()
        expect(Number.isInteger(prev.complete)).toBe(false)
        const modifier = dragStart(next, NextPosition - PPQN.Quarter, false)
        expect(modifier.selectedModifyStrategy().readPosition(next)).toBe(Math.ceil(prev.complete))
        project.terminate()
    })

    it("Ctrl start drag (aligned) as in the live log keeps the track valid", async () => {
        const {project, track, prev, next, dragStart, RegionClipResolver} = await setup()
        const complete = next.complete
        const modifier = dragStart(prev, PrevPosition, true)
        expect(() => modifier.approve()).not.toThrow()
        expect(next.position).toBe(32099)
        expect(next.complete).toBeCloseTo(complete, 6)
        expect(() => RegionClipResolver.validateTrack(track)).not.toThrow()
        project.terminate()
    })

    it("plain start drag past the neighbour end keeps the track valid", async () => {
        const {project, track, prev, next, dragStart, RegionClipResolver} = await setup()
        const modifier = dragStart(next, NextPosition - PPQN.Quarter, false)
        expect(() => modifier.approve()).not.toThrow()
        expect(next.position).toBe(Math.ceil(prev.complete))
        expect(() => RegionClipResolver.validateTrack(track)).not.toThrow()
        project.terminate()
    })
})
