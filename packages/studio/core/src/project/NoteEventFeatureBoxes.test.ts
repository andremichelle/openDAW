import {describe, expect, it} from "vitest"
import {asInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    BoxIO,
    NoteEventBox,
    NoteEventChanceBox,
    NoteEventChanceGroupBox,
    NoteEventCollectionBox,
    NoteEventRepeatBox,
    NoteRegionBox,
    TimelineBox,
    TrackBox
} from "@opendaw/studio-boxes"

const Bar = 3840

// One notes track with one region and an empty note collection.
const buildSkeleton = () => {
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
        box.position.setValue(0)
        box.duration.setValue(Bar)
        box.loopDuration.setValue(Bar)
        box.regions.refer(trackBox.regions)
        box.events.refer(collection.owners)
    })
    boxGraph.endTransaction()
    return {skeleton, boxGraph, collection}
}

const createNote = (boxGraph: BoxGraph<BoxIO.TypeMap>, collection: NoteEventCollectionBox, pitch: number) =>
    NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.position.setValue(0)
        box.duration.setValue(960)
        box.pitch.setValue(pitch)
    })

const reload = (boxGraph: BoxGraph<BoxIO.TypeMap>): BoxGraph<BoxIO.TypeMap> => {
    const loaded = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    loaded.fromArrayBuffer(boxGraph.toArrayBuffer())
    return loaded
}

describe("NoteEvent feature boxes", () => {
    it("keeps the current note fields through save and load", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const note = createNote(boxGraph, collection, 42)
        note.velocity.setValue(0.5)
        note.cent.setValue(25)
        note.chance.setValue(50)
        note.playCount.setValue(4)
        note.playCurve.setValue(0.5)
        boxGraph.endTransaction()
        const loaded = asInstanceOf(reload(boxGraph).findBox(note.address.uuid).unwrap("note"), NoteEventBox)
        expect(loaded.pitch.getValue()).toBe(42)
        expect(loaded.velocity.getValue()).toBe(0.5)
        expect(loaded.cent.getValue()).toBe(25)
        expect(loaded.chance.getValue()).toBe(50)
        expect(loaded.playCount.getValue()).toBe(4)
        expect(loaded.playCurve.getValue()).toBe(0.5)
    })
    it("keeps chance, group and repeat boxes through save and load", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const root = createNote(boxGraph, collection, 60)
        const third = createNote(boxGraph, collection, 64)
        const group = NoteEventChanceGroupBox.create(boxGraph, UUID.generate(), box => {
            box.chance.setValue(60)
            box.mode.setValue(1)
        })
        const chances = [root, third].map(note => NoteEventChanceBox.create(boxGraph, UUID.generate(), box => {
            box.event.refer(note.random)
            box.chance.setValue(30)
            box.group.refer(group)
        }))
        const repeat = NoteEventRepeatBox.create(boxGraph, UUID.generate(), box => {
            box.event.refer(root.split)
            box.count.setValue(3)
            box.curve.setValue(-0.25)
            box.length.setValue(0.5)
            box.velocityFade.setValue(0.75)
        })
        boxGraph.endTransaction()
        const loaded = reload(boxGraph)
        const loadedGroup = asInstanceOf(loaded.findBox(group.address.uuid).unwrap("group"), NoteEventChanceGroupBox)
        expect(loadedGroup.chance.getValue()).toBe(60)
        expect(loadedGroup.mode.getValue()).toBe(1)
        expect(loadedGroup.pointerHub.incoming().length).toBe(2)
        chances.forEach((chance, index) => {
            const loadedChance = asInstanceOf(loaded.findBox(chance.address.uuid).unwrap("chance"), NoteEventChanceBox)
            expect(loadedChance.chance.getValue()).toBe(30)
            expect(UUID.equals(loadedChance.event.targetAddress.unwrap("event").uuid,
                [root, third][index].address.uuid)).toBe(true)
            expect(UUID.equals(loadedChance.group.targetAddress.unwrap("group").uuid, group.address.uuid)).toBe(true)
        })
        const loadedRepeat = asInstanceOf(loaded.findBox(repeat.address.uuid).unwrap("repeat"), NoteEventRepeatBox)
        expect(loadedRepeat.count.getValue()).toBe(3)
        expect(loadedRepeat.curve.getValue()).toBe(-0.25)
        expect(loadedRepeat.length.getValue()).toBe(0.5)
        expect(loadedRepeat.velocityFade.getValue()).toBe(0.75)
        expect(UUID.equals(loadedRepeat.event.targetAddress.unwrap("event").uuid, root.address.uuid)).toBe(true)
    })
    it("keeps the timeline seed through save and load", () => {
        const {skeleton, boxGraph} = buildSkeleton()
        const {timelineBox} = skeleton.mandatoryBoxes
        expect(timelineBox.seed.getValue()).toBe(0)
        boxGraph.beginTransaction()
        timelineBox.seed.setValue(4711)
        boxGraph.endTransaction()
        expect(asInstanceOf(reload(boxGraph).findBox(timelineBox.address.uuid).unwrap("timelineBox"), TimelineBox).seed.getValue()).toBe(4711)
    })
    it("deletes the chance and repeat boxes with their note", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const note = createNote(boxGraph, collection, 60)
        const chance = NoteEventChanceBox.create(boxGraph, UUID.generate(), box => box.event.refer(note.random))
        const repeat = NoteEventRepeatBox.create(boxGraph, UUID.generate(), box => box.event.refer(note.split))
        boxGraph.endTransaction()
        boxGraph.beginTransaction()
        note.delete()
        boxGraph.endTransaction()
        expect(boxGraph.findBox(chance.address.uuid).isEmpty()).toBe(true)
        expect(boxGraph.findBox(repeat.address.uuid).isEmpty()).toBe(true)
    })
    it("accepts only one chance box per note", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const note = createNote(boxGraph, collection, 60)
        NoteEventChanceBox.create(boxGraph, UUID.generate(), box => box.event.refer(note.random))
        boxGraph.endTransaction()
        expect(() => {
            boxGraph.beginTransaction()
            NoteEventChanceBox.create(boxGraph, UUID.generate(), box => box.event.refer(note.random))
            boxGraph.endTransaction()
        }).toThrow()
    })
    it("deletes the group with its last member note", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const root = createNote(boxGraph, collection, 60)
        const third = createNote(boxGraph, collection, 64)
        const group = NoteEventChanceGroupBox.create(boxGraph, UUID.generate())
        ;[root, third].forEach(note => NoteEventChanceBox.create(boxGraph, UUID.generate(), box => {
            box.event.refer(note.random)
            box.group.refer(group)
        }))
        boxGraph.endTransaction()
        boxGraph.beginTransaction()
        root.delete()
        boxGraph.endTransaction()
        expect(boxGraph.findBox(group.address.uuid).nonEmpty()).toBe(true)
        boxGraph.beginTransaction()
        third.delete()
        boxGraph.endTransaction()
        expect(boxGraph.findBox(group.address.uuid).isEmpty()).toBe(true)
    })
    it("does not allow a group without members", () => {
        const {boxGraph} = buildSkeleton()
        expect(() => {
            boxGraph.beginTransaction()
            NoteEventChanceGroupBox.create(boxGraph, UUID.generate())
            boxGraph.endTransaction()
        }).toThrow()
    })
})
