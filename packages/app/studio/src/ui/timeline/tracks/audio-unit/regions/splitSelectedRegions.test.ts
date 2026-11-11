import {splitSelectedRegions} from "./splitSelectedRegions"
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

describe("split selected regions at playhead", () => {
    it("splits selected regions at the same position in one undo step", async () => {
        const {project, trackAdapter: track} = await buildProject([{position: 0, duration: 960}, {position: 1920, duration: 960}])
        const source = track.regions.collection.asArray()[0]
        project.regionSelection.select(source)
        splitSelectedRegions(project, 480)
        expect(track.regions.collection.asArray().map(r => [r.position, r.duration]))
            .toEqual([[0, 480], [480, 480], [1920, 960]])
        expect(project.regionSelection.selected()).toEqual([source])
        expect(project.editing.undo()).toBe(true)
        expect(track.regions.collection.asArray().map(r => [r.position, r.duration]))
            .toEqual([[0, 960], [1920, 960]])
        expect(project.editing.redo()).toBe(true)
        expect(track.regions.collection.asArray()).toHaveLength(3)
        project.terminate()
    })
    it("does nothing with no selection or a playhead on a clip edge", async () => {
        const {project, trackAdapter: track} = await buildProject([{position: 100, duration: 960}])
        splitSelectedRegions(project, 580)
        project.regionSelection.select(...track.regions.collection.asArray())
        splitSelectedRegions(project, 100)
        splitSelectedRegions(project, 1060)
        splitSelectedRegions(project, 1200)
        expect(track.regions.collection.asArray().map(r => [r.position, r.duration])).toEqual([[100, 960]])
        project.terminate()
    })
})
