import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, SelectionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {TimeBase} from "@opendaw/lib-dsp"
import type {ProjectEnv} from "./ProjectEnv"

// jsdom lacks the Web Audio worklet globals that EngineWorklet extends at module-eval time, so a
// static import of Project would throw on load. Stub it, then import Project dynamically below.
if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

// A sample manager whose loaders never actually load: the region adapter only subscribes to the
// loader at construction, so an inert stub is enough to exercise the construction path.
const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {},
    invalidate: () => {},
    remove: () => {},
    register: () => Terminable.Empty
})

// Only sampleManager is exercised during construction; the remaining members are touched lazily.
const createEnv = (): ProjectEnv => ({
    audioContext: undefined,
    audioWorklets: undefined,
    sampleManager: createSampleManager(),
    soundfontManager: undefined,
    sampleService: undefined,
    soundfontService: undefined
}) as unknown as ProjectEnv

describe("Project init order", () => {
    // Regression: a loaded project containing a seconds-based audio region that is already selected
    // makes the remote-selection catchup build an AudioRegionBoxAdapter during construction. That
    // adapter subscribes to context.tempoMap, which must already exist at that point.
    it("creates tempoMap before selection-driven region adapters subscribe to it", async () => {
        const {Project} = await import("./Project")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox, userInterfaceBoxes}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(1))
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(TimeBase.Seconds)
            box.position.setValue(0)
            box.duration.setValue(1)
            box.loopDuration.setValue(1)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
        SelectionBox.create(boxGraph, UUID.generate(), box => {
            box.selectable.refer(regionBox)
            box.selection.refer(userInterfaceBoxes[0].selection)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton(createEnv(), skeleton)
        expect(project.tempoMap).toBeDefined()
        project.terminate()
    })
})
