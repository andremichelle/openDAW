import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    NoteClipBoxAdapter,
    NoteEventBoxAdapter,
    NoteRegionBoxAdapter,
    ProjectSkeleton,
    RegionEditing,
    TrackType
} from "@opendaw/studio-adapters"
import {NoteClipBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
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

const Bar = 3840

// A detuned four-hit roll that speeds up (play curve 0.5) and plays half of the time (chance 50).
const Source = {pitch: 42, velocity: 0.5, cent: 25, chance: 50, playCount: 4, playCurve: 0.5} as const

// One notes track holding one 2-bar region with a single note on beat 4 of bar 1.
const buildProject = async () => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    const regionBox = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(Bar * 2)
        box.loopDuration.setValue(Bar * 2)
        box.regions.refer(trackBox.regions)
        box.events.refer(events.owners)
    })
    const noteBox = NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(2880)
        box.duration.setValue(960)
        box.pitch.setValue(Source.pitch)
        box.velocity.setValue(Source.velocity)
        box.cent.setValue(Source.cent)
        box.chance.setValue(Source.chance)
        box.playCount.setValue(Source.playCount)
        box.playCurve.setValue(Source.playCurve)
        box.events.refer(events.events)
    })
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const region = project.boxAdapters.adapterFor(regionBox, NoteRegionBoxAdapter)
    const note = project.boxAdapters.adapterFor(noteBox, NoteEventBoxAdapter)
    return {project, trackBox, events, region, note}
}

const settingsOf = ({pitch, velocity, cent, chance, playCount, playCurve}: NoteEventBoxAdapter) =>
    ({pitch, velocity, cent, chance, playCount, playCurve})

const onlyNoteOf = (region: NoteRegionBoxAdapter | NoteClipBoxAdapter): NoteEventBoxAdapter => {
    const notes = region.optCollection.unwrap("collection").events.asArray()
    expect(notes.length).toBe(1)
    return notes[0]
}

describe("copying a note keeps all of its settings", () => {
    it("Duplicating notes keeps fine tune, chance, play count and play curve", async () => {
        const {project, note} = await buildProject()
        const [copy] = project.editing.modify(() => project.api.duplicateNotes([note])).unwrap("modify")
        expect(settingsOf(copy)).toEqual(Source)
        // The copy still lands flush after the source, in the source's own collection.
        expect(copy.position).toBe(3840)
        expect(copy.duration).toBe(960)
        expect(copy.collection.unwrap("copy.collection")).toBe(note.collection.unwrap("note.collection"))
        project.terminate()
    })

    it("A copied note keeps its play curve", async () => {
        const {project, note} = await buildProject()
        const copy = project.editing.modify(() => note.copyTo({position: 0})).unwrap("modify")
        expect(settingsOf(copy)).toEqual(Source)
        project.terminate()
    })

    it("A duplicated note region keeps its notes' play curve", async () => {
        const {project, region} = await buildProject()
        const duplicate = project.editing.modify(() =>
            project.api.duplicateRegion(region, {position: Bar * 2})).unwrap("modify").unwrap("duplicate")
        expect(settingsOf(onlyNoteOf(duplicate))).toEqual(Source)
        project.terminate()
    })

    it("A region split with consolidate keeps the play curve", async () => {
        const {project, region} = await buildProject()
        const secondHalf = project.editing.modify(() =>
            RegionEditing.cut(region, 1920, true)).unwrap("modify").unwrap("cut")
        expect(secondHalf.optCollection.unwrap()).not.toBe(region.optCollection.unwrap())
        expect(settingsOf(onlyNoteOf(secondHalf))).toEqual(Source)
        project.terminate()
    })

    it("Consolidating a mirrored region keeps the play curve", async () => {
        const {project, region, note} = await buildProject()
        project.editing.modify(() => {
            region.copyTo({position: Bar * 2})
            region.consolidate()
        })
        const copy = onlyNoteOf(region)
        expect(copy).not.toBe(note)
        expect(settingsOf(copy)).toEqual(Source)
        project.terminate()
    })

    it("Consolidating a mirrored clip keeps the play curve", async () => {
        const {project, trackBox, events, region, note} = await buildProject()
        // The clip shares the region's notes, as it does after Convert to Region or a mirrored copy.
        const clipBox = project.editing.modify(() => NoteClipBox.create(project.boxGraph, UUID.generate(), box => {
            box.duration.setValue(Bar * 2)
            box.clips.refer(trackBox.clips)
            box.events.refer(events.owners)
        })).unwrap("modify")
        const clip = project.boxAdapters.adapterFor(clipBox, NoteClipBoxAdapter)
        expect(clip.isMirrowed).toBe(true)
        project.editing.modify(() => clip.consolidate())
        const copy = onlyNoteOf(clip)
        expect(copy).not.toBe(note)
        expect(onlyNoteOf(region)).toBe(note)
        expect(settingsOf(copy)).toEqual(Source)
        project.terminate()
    })

    it("Flattening note regions keeps the play curve", async () => {
        const {project, region} = await buildProject()
        region.onSelected()
        const flattened = project.editing.modify(() => region.flatten([region])).unwrap("modify").unwrap("flatten")
        expect(settingsOf(onlyNoteOf(project.boxAdapters.adapterFor(flattened, NoteRegionBoxAdapter)))).toEqual(Source)
        project.terminate()
    })

    it("Consolidating a play-count note gives plain hits that keep fine tune, chance and velocity", async () => {
        const {project, note} = await buildProject()
        const hits = project.editing.modify(() => note.consolidate()).unwrap("modify")
        expect(hits.length).toBe(Source.playCount)
        hits.forEach(hit => expect(settingsOf(hit)).toEqual({...Source, playCount: 1, playCurve: 0}))
        project.terminate()
    })
})
