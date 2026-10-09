import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ppqn, TimeBase} from "@opendaw/lib-dsp"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {StudioPreferences} from "../../../StudioPreferences"
import type {ProjectEnv} from "../../../project/ProjectEnv"
import {RegionsClipboard} from "./RegionsClipboardHandler"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}
const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})
const env = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

// Live error 1165: a region with a fractional duration (295.6) is copied, which moves the playhead to its
// fractional complete. The paste mask started at 295.6 while the pasted region's Int32 position stored 295.
const buildTrackWithRegion = async (duration: ppqn) => {
    const {Project} = await import("../../../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const audioFileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => {
        box.fileName.setValue("take.wav")
        box.endInSeconds.setValue(1)
    })
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    AudioRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(duration)
        box.loopDuration.setValue(duration)
        box.timeBase.setValue(TimeBase.Musical)
        box.regions.refer(trackBox.regions)
        box.file.refer(audioFileBox)
        box.events.refer(events.owners)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(env(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter}
}

const createHandler = (project: Awaited<ReturnType<typeof buildTrackWithRegion>>["project"],
                       trackAdapter: TrackBoxAdapter, playhead: {value: ppqn}) =>
    RegionsClipboard.createHandler({
        getEnabled: () => true,
        getPosition: () => playhead.value,
        setPosition: position => playhead.value = position,
        editing: project.editing,
        selection: project.regionSelection,
        boxGraph: project.boxGraph,
        boxAdapters: project.boxAdapters,
        getTracks: () => [trackAdapter],
        getFocusedTrack: () => Option.wrap(trackAdapter),
        overlapResolver: project.overlapResolver
    })

afterEach(() => {
    StudioPreferences.settings.editing["overlapping-regions-behaviour"] = "clip"
})

describe("RegionsClipboard paste at a fractional playhead (live error 1165)", () => {
    it("copy then paste of a fractional-length region does not overlap the original", async () => {
        const {project, trackAdapter} = await buildTrackWithRegion(295.6000061035156)
        const playhead = {value: 0}
        const handler = createHandler(project, trackAdapter, playhead)
        project.regionSelection.select(...trackAdapter.regions.collection.asArray())
        const entry = handler.copy().unwrap("copy")
        expect(playhead.value).toBeCloseTo(295.6, 3)
        expect(() => handler.paste(entry)).not.toThrow()
        expect(() => handler.paste(entry)).not.toThrow()
        const regions = trackAdapter.regions.collection.asArray()
        for (let i = 1; i < regions.length; i++) {
            expect(regions[i - 1].complete).toBeLessThanOrEqual(regions[i].position)
        }
    })

    it("a paste at a fractional stopped playhead clips the region underneath", async () => {
        const {project, trackAdapter} = await buildTrackWithRegion(960)
        const playhead = {value: 0}
        const handler = createHandler(project, trackAdapter, playhead)
        project.regionSelection.select(...trackAdapter.regions.collection.asArray())
        const entry = handler.copy().unwrap("copy")
        playhead.value = 959.7
        expect(() => handler.paste(entry)).not.toThrow()
        const regions = trackAdapter.regions.collection.asArray()
        expect(regions.length).toBe(2)
        expect(regions[0].complete).toBeLessThanOrEqual(regions[1].position)
        expect(regions[1].position).toBe(959)
    })
})
