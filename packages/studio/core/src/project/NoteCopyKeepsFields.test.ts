import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {
    NoteClipBoxAdapter,
    NoteEventBoxAdapter,
    NoteRegionBoxAdapter,
    ProjectSkeleton,
    RegionEditing,
    TrackType,
    NoteEventFeatures
} from "@opendaw/studio-adapters"
import {NoteClipBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"
import {ControlType} from "@opendaw/lib-midi"
import {NoteMidiExport} from "./NoteMidiExport"

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
        box.events.refer(events.events)
    })
    NoteEventFeatures.writeChance(noteBox, Source.chance)
    NoteEventFeatures.writePlayCount(noteBox, Source.playCount)
    NoteEventFeatures.writePlayCurve(noteBox, Source.playCurve)
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
    it("The adapter reads a feature written in the same edit", async () => {
        const {project, note} = await buildProject()
        const read = project.editing.modify(() => {
            NoteEventFeatures.writePlayCount(note.box, 1)
            NoteEventFeatures.writeChance(note.box, 100)
            const cleared = {playCount: note.playCount, chance: note.chance}
            NoteEventFeatures.writePlayCount(note.box, 6)
            NoteEventFeatures.writeChance(note.box, 20)
            return {cleared, written: {playCount: note.playCount, chance: note.chance}}
        }).unwrap("modify")
        expect(read).toEqual({cleared: {playCount: 1, chance: 100}, written: {playCount: 6, chance: 20}})
        project.terminate()
    })
    it("Duplicating notes and selecting the copies is one undo step", async () => {
        const {project, note, region} = await buildProject()
        project.selection.select(note.box)
        const count = () => region.optCollection.unwrap("collection").events.asArray().length
        project.editing.modify(() => {
            const copies = project.api.duplicateNotes([note])
            project.selection.deselectAll()
            copies.forEach(copy => project.selection.select(copy.box))
        })
        expect(count()).toBe(2)
        project.editing.undo()
        expect(count()).toBe(1)
        project.terminate()
    })
    it("Consolidating a grouped play-count note keeps its hits in the same group", async () => {
        const {project, note} = await buildProject()
        const group = project.editing.modify(() =>
            NoteEventFeatures.group([note.box], NoteEventFeatures.GroupMode.PlayAll).unwrap("group")).unwrap("modify")
        const hits = project.editing.modify(() => note.consolidate()).unwrap("modify")
        hits.forEach(hit => expect(hit.group.unwrap("group")).toBe(group))
        expect(group.pointerHub.incoming().length).toBe(Source.playCount)
        project.terminate()
    })
    it("Consolidating an ungrouped note with chance groups its hits, so they still decide once", async () => {
        const {project, note} = await buildProject()
        const hits = project.editing.modify(() => note.consolidate()).unwrap("modify")
        const group = hits[0].group.unwrap("group")
        hits.forEach(hit => expect(hit.group.unwrap("group")).toBe(group))
        expect(group.mode.getValue()).toBe(NoteEventFeatures.GroupMode.PlayAll)
        expect(group.chance.getValue()).toBe(Source.chance)
        hits.forEach(hit => expect(NoteEventFeatures.chanceBox(hit.box).isEmpty()).toBe(true))
        project.terminate()
    })
    it("Consolidating an ungrouped note at full chance leaves its hits ungrouped", async () => {
        const {project, note} = await buildProject()
        project.editing.modify(() => NoteEventFeatures.writeChance(note.box, 100))
        const hits = project.editing.modify(() => note.consolidate()).unwrap("modify")
        hits.forEach(hit => expect(hit.group.isEmpty()).toBe(true))
        project.terminate()
    })
    it("Consolidating the only member of a Play One group plays all its hits", async () => {
        const {project, note} = await buildProject()
        const group = project.editing.modify(() =>
            NoteEventFeatures.group([note.box], NoteEventFeatures.GroupMode.PlayOne).unwrap("group")).unwrap("modify")
        const hits = project.editing.modify(() => note.consolidate()).unwrap("modify")
        hits.forEach(hit => expect(hit.group.unwrap("group")).toBe(group))
        expect(group.mode.getValue()).toBe(NoteEventFeatures.GroupMode.PlayAll)
        project.terminate()
    })
    it("Consolidating one of several Play One members gives its hits a Play All group of their own", async () => {
        const {project, note} = await buildProject()
        const {group, other} = project.editing.modify(() => {
            const other = note.copyTo({position: note.position + Bar, playCount: 1})
            const group = NoteEventFeatures.group([note.box, other.box], NoteEventFeatures.GroupMode.PlayOne).unwrap("group")
            group.chance.setValue(30)
            return {group, other}
        }).unwrap("modify")
        const hits = project.editing.modify(() => note.consolidate()).unwrap("modify")
        const own = hits[0].group.unwrap("group")
        expect(own).not.toBe(group)
        hits.forEach(hit => expect(hit.group.unwrap("group")).toBe(own))
        expect(own.mode.getValue()).toBe(NoteEventFeatures.GroupMode.PlayAll)
        expect(own.chance.getValue()).toBe(30)
        expect(other.group.unwrap("other group")).toBe(group)
        expect(group.mode.getValue()).toBe(NoteEventFeatures.GroupMode.PlayOne)
        project.terminate()
    })
    it("Length and velocity fade shape the consolidated hits", async () => {
        const {project, note} = await buildProject()
        project.editing.modify(() => {
            NoteEventFeatures.writePlayCurve(note.box, 0.0)
            NoteEventFeatures.writeRepeatLength(note.box, 0.5)
            NoteEventFeatures.writeVelocityFade(note.box, 1.0)
        })
        const hits = project.editing.modify(() => note.consolidate()).unwrap("modify")
        expect(hits.map(({duration}) => duration)).toEqual([120, 120, 120, 120])
        ;[0, Source.velocity / 3, Source.velocity * 2 / 3, Source.velocity]
            .forEach((velocity, index) => expect(hits[index].velocity).toBeCloseTo(velocity, 6))
        project.terminate()
    })
})

describe("MIDI export", () => {
    // Every MIDI note-on and note-off of the exported track, in ticks (96 per quarter).
    const exported = (note: NoteEventBoxAdapter) => NoteMidiExport
        .fromAdapter(note.collection.unwrap("collection")).controlEvents.get(0)
        .map(({ticks, type, param0, param1}) => ({ticks, type, pitch: param0, velocity: param1}))

    it("writes every part of a repeated note, as Consolidate creates them", async () => {
        const {project, note} = await buildProject()
        project.editing.modify(() => {
            NoteEventFeatures.writeRepeatLength(note.box, 0.5)
            NoteEventFeatures.writeVelocityFade(note.box, -0.5)
        })
        const before = exported(note)
        expect(before.filter(({type}) => type === ControlType.NOTE_ON).length).toBe(Source.playCount)
        const [first] = project.editing.modify(() => note.consolidate()).unwrap("modify")
        expect(exported(first)).toEqual(before)
        project.terminate()
    })

    it("writes a note without repeats once", async () => {
        const {project, note} = await buildProject()
        project.editing.modify(() => NoteEventFeatures.writePlayCount(note.box, 1))
        expect(exported(note)).toEqual([
            {ticks: 288, type: ControlType.NOTE_ON, pitch: Source.pitch, velocity: 64},
            {ticks: 384, type: ControlType.NOTE_OFF, pitch: Source.pitch, velocity: 0}
        ])
        project.terminate()
    })
})
