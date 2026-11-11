import {createAudioFadeCurveDrag, readFadeCurvePositions} from "./AudioFadeCurveDrag"
import {createAudioFadeLengthDrag} from "./AudioFadeLengthDrag"
import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioRegionBoxAdapter, ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {FadingEnvelope, TimeBase} from "@opendaw/lib-dsp"
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

describe("new fade length drags", () => {
    it.each([true, false])("starts a new fade as a straight line with Undo/Redo, fadeIn=%s", async fadeIn => {
        const {project, left} = await setup()
        project.editing.modify(() => {
            left.fading.inField.setValue(0)
            left.fading.outField.setValue(0)
        })
        const drag = createAudioFadeLengthDrag(left.fading, left.duration, fadeIn, 0, project.editing)
        drag.update(fadeIn ? 960 : -960)
        drag.approve()
        expect(fadeIn ? left.fading.inSlope : left.fading.outSlope).toBe(0.5)
        for (const fraction of [0.25, 0.5, 0.75]) {
            const position = fadeIn ? 960 * fraction : left.duration - 960 + 960 * fraction
            expect(FadingEnvelope.gainAt(position, left.duration, left.fading))
                .toBeCloseTo(fadeIn ? fraction : 1 - fraction)
        }
        project.editing.undo()
        expect(fades(left)).toEqual([0, 0])
        expect(left.fading.inSlope).toBeCloseTo(0.7)
        expect(left.fading.outSlope).toBeCloseTo(0.3)
        project.editing.redo()
        expect(fadeIn ? left.fading.in : left.fading.out).toBe(960)
        expect(fadeIn ? left.fading.inSlope : left.fading.outSlope).toBe(0.5)
        project.terminate()
    })
    it.each([true, false])("preserves existing curved fades and restores canceled drags, fadeIn=%s", async fadeIn => {
        const {project, left} = await setup()
        const drag = createAudioFadeLengthDrag(left.fading, left.duration, fadeIn, 0, project.editing)
        drag.update(fadeIn ? 3000 : -3000)
        expect(left.fading.inSlope).toBeCloseTo(0.7)
        expect(left.fading.outSlope).toBeCloseTo(0.3)
        drag.cancel()
        expect(fades(left)).toEqual([480, 960])
        project.editing.modify(() => (fadeIn ? left.fading.inField : left.fading.outField).setValue(0))
        const fresh = createAudioFadeLengthDrag(left.fading, left.duration, fadeIn, 0, project.editing)
        fresh.update(fadeIn ? 960 : -960)
        fresh.cancel()
        expect(fades(left)).toEqual(fadeIn ? [0, 960] : [480, 0])
        expect(left.fading.inSlope).toBeCloseTo(0.7)
        expect(left.fading.outSlope).toBeCloseTo(0.3)
        project.terminate()
    })
})


describe("movable fade curve points", () => {
    it.each([true, false])("saves both coordinates, restores Undo/Redo and cancels the next drag, fadeIn=%s", async fadeIn => {
        const {project, left} = await setup()
        project.editing.modify(() => {
            left.fading.inSlopeField.setValue(0.5)
            left.fading.outSlopeField.setValue(0.5)
        })
        const originalLengths = fades(left)
        const drag = createAudioFadeCurveDrag(left, fadeIn, 100, 55, project.editing)
        drag.update(20, 8)
        drag.approve()
        const key = fadeIn ? "in" : "out"
        const slope = fadeIn ? left.fading.inSlope : left.fading.outSlope
        expect(readFadeCurvePositions(left.box)[key]).toBeCloseTo(0.7)
        expect(fades(left)).toEqual(originalLengths)
        const loaded = ProjectSkeleton.decode(ProjectSkeleton.encode(project.boxGraph))
        const loadedBox = loaded.boxGraph.findBox(left.box.address.uuid).unwrap() as AudioRegionBox
        expect(readFadeCurvePositions(loadedBox)[key]).toBeCloseTo(0.7)
        expect(fadeIn ? loadedBox.fading.inSlope.getValue() : loadedBox.fading.outSlope.getValue()).toBe(slope)
        project.editing.undo()
        expect(readFadeCurvePositions(left.box)).toEqual({in: 0.5, out: 0.5})
        expect(fadeIn ? left.fading.inSlope : left.fading.outSlope).toBe(0.5)
        project.editing.redo()
        expect(readFadeCurvePositions(left.box)[key]).toBeCloseTo(0.7)
        const next = createAudioFadeCurveDrag(left, fadeIn, 100, 55, project.editing)
        next.update(-10, -4)
        next.cancel()
        expect(readFadeCurvePositions(left.box)[key]).toBeCloseTo(0.7)
        expect(fadeIn ? left.fading.inSlope : left.fading.outSlope).toBe(slope)
        project.terminate()
    })
    it("does not create metadata on an unmodified click and cancels the first drag cleanly", async () => {
        const {project, left} = await setup()
        const boxCount = project.boxGraph.boxes().length
        const slope = left.fading.inSlope
        const drag = createAudioFadeCurveDrag(left, true, 100, 55, project.editing)
        drag.update(0, 0)
        expect(project.boxGraph.boxes()).toHaveLength(boxCount)
        drag.update(10, 5)
        drag.cancel()
        expect(readFadeCurvePositions(left.box)).toEqual({in: 0.5, out: 0.5})
        expect(left.fading.inSlope).toBe(slope)
        expect(project.boxGraph.boxes()).toHaveLength(boxCount)
        project.terminate()
    })
})
