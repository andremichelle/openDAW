import {describe, expect, it} from "vitest"
import {asInstanceOf, int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    AnyRegionBoxAdapter,
    NoteRegionBoxAdapter,
    ProjectSkeleton,
    RegionEditing,
    TrackBoxAdapter,
    TrackType
} from "@opendaw/studio-adapters"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {Project} from "./Project"
import type {ProjectEnv} from "./ProjectEnv"

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

type Note = { position: number, duration: number, pitch: int, playCount?: int }
type Layout = { position: number, duration: number, loopDuration: number, notes: ReadonlyArray<Note> }

const Kick = 36
const Stab = 60

// One bar (3840) looped four times: a kick on beat 1 and a half-note stab on beat 4 that crosses the loop line.
const LoopedBar: Layout = {
    position: 0, duration: 15360, loopDuration: 3840, notes: [
        {position: 0, duration: 960, pitch: Kick},
        {position: 2880, duration: 1920, pitch: Stab}
    ]
}

const buildProject = async (layouts: ReadonlyArray<Layout>) => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    layouts.forEach(({position, duration, loopDuration, notes}) => {
        const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        notes.forEach(note => NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(note.position)
            box.duration.setValue(note.duration)
            box.pitch.setValue(note.pitch)
            box.playCount.setValue(note.playCount ?? 1)
            box.events.refer(collection.events)
        }))
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopDuration.setValue(loopDuration)
            box.regions.refer(trackBox.regions)
            box.events.refer(collection.owners)
        })
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const trackAdapter = project.boxAdapters.adapterFor(trackBox, TrackBoxAdapter)
    return {project, trackAdapter}
}

// flatten only accepts selected regions (canFlatten), so every region is selected first.
const flatten = (project: Project, regions: ReadonlyArray<AnyRegionBoxAdapter>,
                 truncateNotesAtRegionEnd?: boolean): ReadonlyArray<Note> => {
    regions.forEach(region => region.onSelected())
    const box = project.editing.modify(() => asInstanceOf(regions[0], NoteRegionBoxAdapter)
        .flatten(regions, truncateNotesAtRegionEnd)).unwrap("modify").unwrap("flatten")
    return project.boxAdapters.adapterFor(box, NoteRegionBoxAdapter).optCollection.unwrap("collection").events.asArray()
        .map(({position, duration, pitch, playCount}) => ({position, duration, pitch, playCount}))
}

const ofPitch = (notes: ReadonlyArray<Note>, pitch: int) => notes
    .filter(note => note.pitch === pitch)
    .map(({position, duration}) => ({position, duration}))

describe("NoteRegionBoxAdapter.flatten keeps each note as long as it played", () => {
    it("cuts a note at the loop line when notes stop at region end", async () => {
        const {project, trackAdapter} = await buildProject([LoopedBar])
        const notes = flatten(project, trackAdapter.regions.collection.asArray(), true)
        expect(ofPitch(notes, Stab)).toEqual([
            {position: 2880, duration: 960},
            {position: 6720, duration: 960},
            {position: 10560, duration: 960},
            {position: 14400, duration: 960}
        ])
        expect(ofPitch(notes, Kick)).toEqual([
            {position: 0, duration: 960},
            {position: 3840, duration: 960},
            {position: 7680, duration: 960},
            {position: 11520, duration: 960}
        ])
        project.terminate()
    })

    it("cuts a note at the end of its own region when regions are joined", async () => {
        const {project, trackAdapter} = await buildProject([
            {position: 0, duration: 3840, loopDuration: 3840, notes: [{position: 2880, duration: 1920, pitch: Stab}]},
            {position: 3840, duration: 3840, loopDuration: 3840, notes: [{position: 0, duration: 960, pitch: Kick}]}
        ])
        const notes = flatten(project, trackAdapter.regions.collection.asArray(), true)
        expect(ofPitch(notes, Stab)).toEqual([{position: 2880, duration: 960}])
        expect(ofPitch(notes, Kick)).toEqual([{position: 3840, duration: 960}])
        project.terminate()
    })

    it("keeps a note cut where a split cut it", async () => {
        const {project, trackAdapter} = await buildProject([
            {position: 0, duration: 7680, loopDuration: 7680, notes: [{position: 2880, duration: 1920, pitch: Stab}]}
        ])
        const [region] = trackAdapter.regions.collection.asArray()
        project.editing.modify(() => RegionEditing.cut(region, 3840, false))
        const halves = trackAdapter.regions.collection.asArray()
        expect(halves.length).toBe(2)
        const notes = flatten(project, halves, true)
        expect(ofPitch(notes, Stab)).toEqual([{position: 2880, duration: 960}])
        project.terminate()
    })

    it("matches the engine's truncate test", async () => {
        // crates/engine-env/tests/note_sequencer.rs truncate_mode_cuts_notes_at_the_loop_cycle_end
        const {project, trackAdapter} = await buildProject([
            {position: 0, duration: 200, loopDuration: 100, notes: [{position: 90, duration: 50, pitch: Stab}]}
        ])
        const notes = flatten(project, trackAdapter.regions.collection.asArray(), true)
        expect(ofPitch(notes, Stab)).toEqual([{position: 90, duration: 10}, {position: 190, duration: 10}])
        project.terminate()
    })

    it("keeps full lengths when notes ring on", async () => {
        const {project, trackAdapter} = await buildProject([LoopedBar])
        const notes = flatten(project, trackAdapter.regions.collection.asArray())
        // the last stab rings past the region end (15360) to 16320, like by_default_a_note_rings_past_the_region_end
        expect(ofPitch(notes, Stab)).toEqual([
            {position: 2880, duration: 1920},
            {position: 6720, duration: 1920},
            {position: 10560, duration: 1920},
            {position: 14400, duration: 1920}
        ])
        project.terminate()
    })

    it("leaves a ratchet whole", async () => {
        const {project, trackAdapter} = await buildProject([{
            ...LoopedBar, notes: [{position: 2880, duration: 1920, pitch: Stab, playCount: 4}]
        }])
        const notes = flatten(project, trackAdapter.regions.collection.asArray(), true)
        expect(notes.map(({duration, playCount}) => ({duration, playCount})))
            .toEqual(Array.from({length: 4}, () => ({duration: 1920, playCount: 4})))
        project.terminate()
    })
})
