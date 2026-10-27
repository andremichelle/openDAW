import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {TimeBase} from "@opendaw/lib-dsp"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {StudioPreferences} from "../StudioPreferences"
import {RegionClipResolver} from "../ui/timeline/RegionClipResolver"
import type {ProjectEnv} from "./ProjectEnv"

// Live error 1164 ("regions overlap: prev.complete(2880.04345703125) > next.position(2880)"). Switching an
// audio region to Timestretch makes it musical with a fractional float32 duration (converted from seconds).
// duplicateRegion placed the copy at `region.complete` (2880.0434) and built the clip mask from that value,
// but `position` is Int32: the copy was stored at 2880, overlapping the source by the dropped fraction.

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

// The exact geometry from the 1164 log dump (before the failing duplicate).
const FRACTIONAL_DURATION = 2880.04345703125
const Positions = [0, 9600]

const buildProject = async () => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.fileName.setValue("loop.wav")
        box.endInSeconds.setValue(3.0)
    })
    Positions.forEach(position => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(FRACTIONAL_DURATION)
            box.loopDuration.setValue(FRACTIONAL_DURATION)
            box.timeBase.setValue(TimeBase.Musical)
            box.regions.refer(trackBox.regions)
            box.file.refer(audioFileBox)
            box.events.refer(events.owners)
        })
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter}
}

const setBehaviour = (value: "clip" | "push-existing" | "keep-existing") => {
    StudioPreferences.settings.editing["overlapping-regions-behaviour"] = value
}

afterEach(() => setBehaviour("clip"))

describe("duplicating a musical audio region with a fractional duration (1164)", () => {
    it.each(["clip", "push-existing", "keep-existing"] as const)(
        "places the copy after the source without overlap (%s)", async (behaviour) => {
            setBehaviour(behaviour)
            const {project, trackAdapter} = await buildProject()
            const [first] = trackAdapter.regions.collection.asArray()
            expect(first.duration).toBe(FRACTIONAL_DURATION)
            const copy = project.editing.modify(() =>
                project.api.duplicateRegion(first)).unwrap("modify").unwrap("duplicate")
            expect(() => RegionClipResolver.validateTrack(trackAdapter)).not.toThrow()
            expect(copy.position).toBeGreaterThanOrEqual(first.complete)
            const copyTrack = copy.trackBoxAdapter.unwrap("copy.track")
            if (copyTrack !== trackAdapter) {
                expect(() => RegionClipResolver.validateTrack(copyTrack)).not.toThrow()
            }
            project.terminate()
        })

    it("finds free space without overlap", async () => {
        const {project, trackAdapter} = await buildProject()
        const [first] = trackAdapter.regions.collection.asArray()
        const copy = project.editing.modify(() =>
            project.api.duplicateRegion(first, {findFreeSpace: true})).unwrap("modify").unwrap("duplicate")
        expect(() => RegionClipResolver.validateTrack(trackAdapter)).not.toThrow()
        expect(copy.position).toBeGreaterThanOrEqual(first.complete)
        project.terminate()
    })

    it("rounds a fractional explicit position up to the Int32 grid", async () => {
        const {project, trackAdapter} = await buildProject()
        const [first] = trackAdapter.regions.collection.asArray()
        const copy = project.editing.modify(() =>
            project.api.duplicateRegion(first, {position: first.complete})).unwrap("modify").unwrap("duplicate")
        expect(() => RegionClipResolver.validateTrack(trackAdapter)).not.toThrow()
        expect(copy.position).toBe(Math.ceil(first.complete))
        project.terminate()
    })
})
