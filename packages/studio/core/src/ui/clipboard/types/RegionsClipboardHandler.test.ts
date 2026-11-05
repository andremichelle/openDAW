import {afterEach, describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ppqn, TimeBase} from "@opendaw/lib-dsp"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {
    AudioFileBox, AudioRegionBox, GrooveOffsetBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, ValueEventCollectionBox
} from "@opendaw/studio-boxes"
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

// A note region with a groove: within the project the copy keeps pointing at the same groove, another project
// receives the groove (once) in its groove list.
const buildGroovedRegion = async () => {
    const {Project} = await import("../../../project/Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox, rootBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const groove = GrooveOffsetBox.create(boxGraph, UUID.generate(), box => {
        box.label.setValue("Late")
        box.collection.refer(rootBox.grooves)
        box.index.setValue(1)
        box.offset.setValue(120)
    })
    const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(960)
        box.loopDuration.setValue(960)
        box.regions.refer(trackBox.regions)
        box.events.refer(events.owners)
        box.groove.refer(groove)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(env(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter, groove}
}

const grooveOf = (region: {box: unknown}) => {
    const box = region.box as NoteRegionBox
    return box.groove.targetVertex.map(vertex => vertex.box)
}

describe("RegionsClipboard with a grooved region", () => {
    it("a paste into the same project points at the same groove", async () => {
        const {project, trackAdapter, groove} = await buildGroovedRegion()
        const playhead = {value: 0}
        const handler = createHandler(project, trackAdapter, playhead)
        project.regionSelection.select(...trackAdapter.regions.collection.asArray())
        const entry = handler.copy().unwrap("copy")
        handler.paste(entry)
        const regions = trackAdapter.regions.collection.asArray()
        expect(regions.length).toBe(2)
        regions.forEach(region => expect(grooveOf(region).unwrapOrNull()).toBe(groove))
        expect(project.rootBoxAdapter.grooves.adapters().length).toBe(2)
    })

    it("a region without a groove is pasted without one", async () => {
        const {project, trackAdapter} = await buildGroovedRegion()
        const region = trackAdapter.regions.collection.asArray()[0].box as NoteRegionBox
        project.editing.modify(() => region.groove.defer())
        const playhead = {value: 0}
        const handler = createHandler(project, trackAdapter, playhead)
        project.regionSelection.select(...trackAdapter.regions.collection.asArray())
        handler.paste(handler.copy().unwrap("copy"))
        const regions = trackAdapter.regions.collection.asArray()
        expect(regions.length).toBe(2)
        regions.forEach(region => expect(grooveOf(region).isEmpty()).toBe(true))
    })

        it("a paste into another project brings the groove into its list", async () => {
        const origin = await buildGroovedRegion()
        const target = await buildGroovedRegion()
        const playhead = {value: 0}
        const copier = createHandler(origin.project, origin.trackAdapter, playhead)
        origin.project.regionSelection.select(...origin.trackAdapter.regions.collection.asArray())
        const entry = copier.copy().unwrap("copy")
        const paster = createHandler(target.project, target.trackAdapter, playhead)
        paster.paste(entry)
        const regions = target.trackAdapter.regions.collection.asArray()
        expect(regions.length).toBe(2)
        const pasted = grooveOf(regions[1]).unwrap("the pasted region has a groove")
        expect(pasted).not.toBe(target.groove)
        expect(target.project.rootBoxAdapter.grooves.adapters().map(adapter => adapter.box)).toContain(pasted)
        expect(target.project.rootBoxAdapter.grooves.adapters().length).toBe(3)
    })
})
