import {duplicateSelectedRegions} from "./duplicateSelectedRegions"
import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
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

type Span = { position: number, duration: number }

const buildProject = async (layout: ReadonlyArray<Span>) => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    layout.forEach(({position, duration}) => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopDuration.setValue(duration)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        })
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter}
}

describe("arrangement duplicate selection", () => {
    it("copies immediately after the source, selects the copy and repeats on that copy", async () => {
        const {project, trackAdapter: track} = await buildProject([{position: 100, duration: 960}])
        const source = track.regions.collection.asArray()[0]
        project.regionSelection.select(source)
        duplicateSelectedRegions(project)
        const regions = track.regions.collection.asArray()
        expect(regions.map(r => r.position)).toEqual([100, 1060])
        expect(project.regionSelection.selected()).toEqual([regions[1]])
        expect(regions[1].trackBoxAdapter.unwrap()).toBe(track)
        expect(project.trackFocus.track.unwrap()).toBe(track)
        duplicateSelectedRegions(project)
        expect(track.regions.collection.asArray().map(r => r.position)).toEqual([100, 1060, 2020])
        expect(project.editing.undo()).toBe(true)
        expect(track.regions.collection.asArray().map(r => r.position)).toEqual([100, 1060])
        expect(project.editing.redo()).toBe(true)
        expect(track.regions.collection.asArray().map(r => r.position)).toEqual([100, 1060, 2020])
        project.terminate()
    })
    it("duplicates adjacent clips as a block without changing the sources", async () => {
        const {project, trackAdapter: track} = await buildProject([{position: 0, duration: 960}, {position: 960, duration: 960}])
        project.regionSelection.select(...track.regions.collection.asArray())
        duplicateSelectedRegions(project)
        expect(track.regions.collection.asArray().map(r => [r.position, r.duration]))
            .toEqual([[0, 960], [960, 960], [1920, 960], [2880, 960]])
        expect(project.regionSelection.count()).toBe(2)
        project.terminate()
    })
    it("does nothing without a selected region", async () => {
        const {project, trackAdapter: track} = await buildProject([{position: 0, duration: 960}])
        duplicateSelectedRegions(project)
        expect(track.regions.collection.asArray()).toHaveLength(1)
        project.terminate()
    })
})
