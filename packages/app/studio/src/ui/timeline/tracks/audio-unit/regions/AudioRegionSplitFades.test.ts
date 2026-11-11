import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioRegionBoxAdapter, ProjectSkeleton, RegionEditing, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {TimeBase} from "@opendaw/lib-dsp"
import type {ProjectEnv} from "@opendaw/studio-core"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const setup = async () => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const track = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const file = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(10))
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    const box = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.timeBase.setValue(TimeBase.Musical)
        box.duration.setValue(3840)
        box.loopDuration.setValue(3840)
        box.regions.refer(track.regions)
        box.file.refer(file)
        box.events.refer(events.owners)
        box.fading.in.setValue(480)
        box.fading.out.setValue(960)
        box.fading.inSlope.setValue(0.7)
        box.fading.outSlope.setValue(0.3)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    return {project, left: project.boxAdapters.adapterFor(box, AudioRegionBoxAdapter),
        track: project.boxAdapters.adapterFor(track, TrackBoxAdapter)}
}
const fades = (region: AudioRegionBoxAdapter) => [region.fading.in, region.fading.out]

describe("audio split outer fades", () => {
    it.each([false, true])("preserves outer fades with Undo/Redo, consolidate=%s", async consolidate => {
        const {project, left, track} = await setup()
        const right = project.editing.modify(() => RegionEditing.cut(left, 1920, consolidate).unwrap()).unwrap()
        expect(fades(left)).toEqual([480, 0])
        expect(fades(right)).toEqual([0, 960])
        expect(left.fading.inSlope).toBeCloseTo(0.7)
        expect(right.fading.outSlope).toBeCloseTo(0.3)
        expect([left.position, left.complete, right.position, right.complete]).toEqual([0, 1920, 1920, 3840])
        expect(project.editing.undo()).toBe(true)
        expect(track.regions.collection.asArray()).toHaveLength(1)
        expect(fades(left)).toEqual([480, 960])
        expect(left.duration).toBe(3840)
        expect(project.editing.redo()).toBe(true)
        expect((track.regions.collection.asArray() as AudioRegionBoxAdapter[]).map(fades)).toEqual([[480, 0], [0, 960]])
        project.terminate()
    })
    it("does not add fades on repeated splits or edge cuts", async () => {
        const {project, left} = await setup()
        const right = project.editing.modify(() => RegionEditing.cut(left, 1920, false).unwrap()).unwrap()
        const last = project.editing.modify(() => RegionEditing.cut(right, 2880, false).unwrap()).unwrap()
        expect([left, right, last].map(fades)).toEqual([[480, 0], [0, 0], [0, 960]])
        expect(RegionEditing.cut(left, 0, false).isEmpty()).toBe(true)
        expect(fades(left)).toEqual([480, 0])
        project.terminate()
    })
    it("preserves outer fades when removing a middle section", async () => {
        const {project, left} = await setup()
        const right = project.editing.modify(() => RegionEditing.clip(left, 960, 1920)).unwrap()
        expect([left, right].map(fades)).toEqual([[480, 0], [0, 960]])
        project.terminate()
    })
    it("limits an outer fade to its remaining piece when cutting inside that fade", async () => {
        const {project, left} = await setup()
        const right = project.editing.modify(() => RegionEditing.cut(left, 120, false).unwrap()).unwrap()
        expect([left, right].map(fades)).toEqual([[120, 0], [0, 960]])
        project.terminate()
    })

})
