// Live errors 1186 and 1187: "regions overlap: prev.complete(…) > next.position(…)". A seconds-based audio region
// legally reaches over the musical regions after it (it ends where its successor starts). When a mask ends exactly
// where one of those musical regions starts, separating or start-trimming the seconds region put its remainder on
// that start: two regions on one position, valid or not depending on their order in the sorted set.
import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {RegionClipResolver} from "./RegionClipResolver"
import type {ProjectEnv} from "../../project/ProjectEnv"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

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

// A seconds region at `secondsAt` lasting 1000 pulses, reaching over musical regions at 300 and 500 (200 each).
const setup = async (secondsAt: number) => {
    const {Project} = await import("../../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(60))
    const region = (timeBase: TimeBase, position: number, pulses: number) => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        const length = timeBase === TimeBase.Seconds ? PPQN.pulsesToSeconds(pulses, 120) : pulses
        return AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(timeBase)
            box.position.setValue(position)
            box.duration.setValue(length)
            box.loopDuration.setValue(length)
            box.loopOffset.setValue(0)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
    }
    region(TimeBase.Seconds, secondsAt, 1000)
    region(TimeBase.Musical, 300, 200)
    region(TimeBase.Musical, 500, 200)
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const track = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    const resolve = (position: number, complete: number) => {
        const exec = RegionClipResolver.fromRange(track, position, complete)
        boxGraph.beginTransaction()
        exec()
        boxGraph.endTransaction()
    }
    const positions = () => track.regions.collection.asArray().map(region => region.position)
    return {project, track, resolve, positions}
}

describe("a seconds region's remainder never lands on another region's start (#1186)", () => {
    it("separating it with a mask that ends where a musical region starts", async () => {
        const {project, track, resolve, positions} = await setup(0)
        resolve(100, 300)
        expect(new Set(positions()).size).toBe(positions().length)
        expect(() => RegionClipResolver.validateTrack(track)).not.toThrow()
        project.terminate()
    })

    it("start-trimming it with a mask that ends where a musical region starts", async () => {
        const {project, track, resolve, positions} = await setup(100)
        resolve(0, 300)
        expect(new Set(positions()).size).toBe(positions().length)
        expect(() => RegionClipResolver.validateTrack(track)).not.toThrow()
        project.terminate()
    })

    it("keeps the remainder when there is room before the next region", async () => {
        const {project, track, resolve, positions} = await setup(0)
        resolve(100, 250)
        expect(positions()).toEqual([0, 250, 300, 500])
        expect(() => RegionClipResolver.validateTrack(track)).not.toThrow()
        project.terminate()
    })

    it("keeps a start-trimmed remainder when there is room before the next region", async () => {
        const {project, track, resolve, positions} = await setup(100)
        resolve(0, 250)
        expect(positions()).toEqual([250, 300, 500])
        expect(() => RegionClipResolver.validateTrack(track)).not.toThrow()
        project.terminate()
    })

    it("drops the remainder when a musical region is start-trimmed to the same mask end", async () => {
        const {project, track, resolve, positions} = await setup(0)
        resolve(100, 400)
        expect(new Set(positions()).size).toBe(positions().length)
        expect(positions()).toEqual([0, 400, 500])
        expect(() => RegionClipResolver.validateTrack(track)).not.toThrow()
        project.terminate()
    })
})
