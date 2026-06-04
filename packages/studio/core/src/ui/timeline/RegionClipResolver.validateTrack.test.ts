import {describe, expect, it, vi} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {TimeBase} from "@opendaw/lib-dsp"
import type {ProjectEnv} from "../../project"

// jsdom lacks the Web Audio worklet globals that EngineWorklet extends at module-eval time, so a
// static import of Project would throw on load. Stub it, then import the modules dynamically below.
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
    record: () => {},
    invalidate: () => {},
    remove: () => {},
    register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined,
    audioWorklets: undefined,
    sampleManager: createSampleManager(),
    soundfontManager: undefined,
    sampleService: undefined,
    soundfontService: undefined
}) as unknown as ProjectEnv

describe("RegionClipResolver.validateTrack", () => {
    // Regression: a region whose duration has become 0 (created upstream in a degenerate state) must
    // not crash the session. validateTrack runs after the edit is already committed, so it logs a
    // diagnostic and continues instead of asserting/panicking.
    it("does not throw on a region with non-positive duration", async () => {
        const {Project} = await import("../../project/Project")
        const {RegionClipResolver} = await import("./RegionClipResolver")
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.tracks.refer(primaryAudioUnitBox.tracks)
            box.target.refer(primaryAudioUnitBox)
        })
        const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(1))
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(TimeBase.Musical)
            box.position.setValue(0)
            box.duration.setValue(15360)
            box.loopDuration.setValue(15360)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
        boxGraph.endTransaction()
        const project = Project.fromSkeleton(createEnv(), skeleton)
        const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
        // Corrupt the region into a degenerate 0-duration state after validation has run.
        boxGraph.beginTransaction()
        regionBox.duration.setValue(0)
        boxGraph.endTransaction()
        const region = trackAdapter.regions.collection.asArray()[0]
        expect(region.duration).toBe(0)
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
        expect(() => RegionClipResolver.validateTrack(trackAdapter)).not.toThrow()
        expect(consoleError).toHaveBeenCalledWith("[validateTrack] NON_POSITIVE_DURATION", expect.any(String))
        consoleError.mockRestore()
        project.terminate()
    })
})
