import {describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {NoteEventBoxAdapter, NoteEventFeatures, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {NoteGrouping} from "./NoteGrouping"

vi.hoisted(() => {
    if (Reflect.get(globalThis, "AudioWorkletNode") === undefined) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
})

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

// A chord of three notes in one region, with a selection of notes like the note editor's
const createChord = async () => {
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.duration.setValue(3840)
        box.loopDuration.setValue(3840)
        box.regions.refer(trackBox.regions)
        box.events.refer(collection.owners)
    })
    const notes = [60, 64, 67].map(pitch => NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.duration.setValue(960)
        box.pitch.setValue(pitch)
    }))
    boxGraph.endTransaction()
    const project = Project.fromSkeleton({
        audioContext: undefined, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as never, skeleton)
    const selection = project.selection.createFilteredSelection(box => box instanceof NoteEventBox, {
        fx: (adapter: NoteEventBoxAdapter) => adapter.box,
        fy: vertex => project.boxAdapters.adapterFor(vertex.box, NoteEventBoxAdapter)
    })
    const adapters = notes.map(box => project.boxAdapters.adapterFor(box, NoteEventBoxAdapter))
    return {project, selection, adapters}
}

describe("NoteGrouping", () => {
    it("groups two or more selected notes", async () => {
        const {project, selection, adapters} = await createChord()
        selection.select(...adapters)
        expect(NoteGrouping.group(project.editing, selection, NoteEventFeatures.GroupMode.PlayAll)).toBe(true)
        expect(NoteGrouping.status(selection)).toBe("Play All, 3 notes")
        project.terminate()
    })
    it("switches the mode of the group when one of its notes is selected", async () => {
        const {project, selection, adapters} = await createChord()
        selection.select(...adapters)
        NoteGrouping.group(project.editing, selection, NoteEventFeatures.GroupMode.PlayAll)
        const group = adapters[0].group.unwrap("group")
        selection.deselectAll()
        selection.select(adapters[1])
        expect(NoteGrouping.group(project.editing, selection, NoteEventFeatures.GroupMode.PlayOne)).toBe(true)
        expect(adapters[1].group.unwrap("group")).toBe(group)
        expect(group.mode.getValue()).toBe(NoteEventFeatures.GroupMode.PlayOne)
        expect(NoteGrouping.status(selection)).toBe("Play One, 3 notes")
        project.terminate()
    })
    it("does nothing for one ungrouped note", async () => {
        const {project, selection, adapters} = await createChord()
        selection.select(adapters[0])
        expect(NoteGrouping.canGroup(selection)).toBe(false)
        expect(NoteGrouping.group(project.editing, selection, NoteEventFeatures.GroupMode.PlayAll)).toBe(false)
        expect(adapters[0].group.isEmpty()).toBe(true)
        project.terminate()
    })
})
