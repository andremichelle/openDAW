import {describe, expect, it} from "vitest"
import {asInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {NoteEventFeatures, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
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
    it("keeps every value written through NoteEventFeatures through save and load", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const note = createNote(boxGraph, collection, 42)
        note.velocity.setValue(0.5)
        note.cent.setValue(25)
        NoteEventFeatures.writeChance(note, 50)
        NoteEventFeatures.writePlayCount(note, 4)
        NoteEventFeatures.writePlayCurve(note, 0.5)
        NoteEventFeatures.writeRepeatLength(note, 0.25)
        NoteEventFeatures.writeVelocityFade(note, -0.5)
        boxGraph.endTransaction()
        const loaded = asInstanceOf(reload(boxGraph).findBox(note.address.uuid).unwrap("note"), NoteEventBox)
        expect(loaded.pitch.getValue()).toBe(42)
        expect(loaded.velocity.getValue()).toBe(0.5)
        expect(loaded.cent.getValue()).toBe(25)
        expect(NoteEventFeatures.read(loaded)).toEqual({
            chance: 50, group: Option.None, playCount: 4, playCurve: 0.5, repeatLength: 0.25, velocityFade: -0.5
        })
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
    it("groups notes with the chance of the first one and deletes groups left empty", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const [root, third, fifth] = [60, 64, 67].map(pitch => createNote(boxGraph, collection, pitch))
        NoteEventFeatures.writeChance(root, 40)
        const first = NoteEventFeatures.group([root, third], NoteEventFeatures.GroupMode.PlayAll).unwrap("group")
        boxGraph.endTransaction()
        expect(first.chance.getValue()).toBe(40)
        expect(NoteEventFeatures.readChance(third)).toBe(40)
        boxGraph.beginTransaction()
        const second = NoteEventFeatures.group([root, third, fifth], NoteEventFeatures.GroupMode.PlayOne).unwrap("group")
        boxGraph.endTransaction()
        expect(first.isAttached()).toBe(false)
        expect(second.mode.getValue()).toBe(NoteEventFeatures.GroupMode.PlayOne)
        expect(second.pointerHub.incoming().length).toBe(3)
    })
    it("writes the chance of a grouped note into its group", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const [root, third] = [60, 64].map(pitch => createNote(boxGraph, collection, pitch))
        const group = NoteEventFeatures.group([root, third], NoteEventFeatures.GroupMode.PlayAll).unwrap("group")
        NoteEventFeatures.writeChance(third, 25)
        boxGraph.endTransaction()
        expect(group.chance.getValue()).toBe(25)
        expect(NoteEventFeatures.readChance(root)).toBe(25)
    })
    it("lets a note leave its group and keeps its own chance", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const [root, third] = [60, 64].map(pitch => createNote(boxGraph, collection, pitch))
        NoteEventFeatures.writeChance(third, 70)
        const group = NoteEventFeatures.group([root, third], NoteEventFeatures.GroupMode.PlayAll).unwrap("group")
        group.chance.setValue(20)
        boxGraph.endTransaction()
        boxGraph.beginTransaction()
        NoteEventFeatures.leaveGroup([third])
        boxGraph.endTransaction()
        expect(NoteEventFeatures.groupBox(third).isEmpty()).toBe(true)
        expect(NoteEventFeatures.readChance(third)).toBe(70)
        expect(NoteEventFeatures.readChance(root)).toBe(20)
        boxGraph.beginTransaction()
        NoteEventFeatures.leaveGroup([root])
        boxGraph.endTransaction()
        expect(group.isAttached()).toBe(false)
    })
    it("ungroups the whole group of a selected note", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const notes = [60, 64, 67].map(pitch => createNote(boxGraph, collection, pitch))
        const group = NoteEventFeatures.group(notes, NoteEventFeatures.GroupMode.PlayAll).unwrap("group")
        boxGraph.endTransaction()
        boxGraph.beginTransaction()
        NoteEventFeatures.ungroup([notes[1]])
        boxGraph.endTransaction()
        expect(group.isAttached()).toBe(false)
        notes.forEach(note => expect(NoteEventFeatures.groupBox(note).isEmpty()).toBe(true))
    })
    it("copies a group once per mapping", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const notes = [60, 64].map(pitch => createNote(boxGraph, collection, pitch))
        NoteEventFeatures.writePlayCount(notes[0], 3)
        const group = NoteEventFeatures.group(notes, NoteEventFeatures.GroupMode.PlayOne).unwrap("group")
        group.chance.setValue(35)
        const shared = NoteEventFeatures.createGroupMapping()
        const together = notes.map(note => {
            const copy = createNote(boxGraph, collection, note.pitch.getValue())
            NoteEventFeatures.copy(note, copy, {split: true, groups: shared})
            return copy
        })
        const apart = notes.map(note => {
            const copy = createNote(boxGraph, collection, note.pitch.getValue())
            NoteEventFeatures.copy(note, copy, {split: false, groups: NoteEventFeatures.createGroupMapping()})
            return copy
        })
        boxGraph.endTransaction()
        const groupOf = (note: NoteEventBox) => NoteEventFeatures.groupBox(note).unwrap("group")
        expect(groupOf(together[0])).toBe(groupOf(together[1]))
        expect(groupOf(together[0])).not.toBe(group)
        expect(groupOf(together[0]).chance.getValue()).toBe(35)
        expect(groupOf(together[0]).mode.getValue()).toBe(NoteEventFeatures.GroupMode.PlayOne)
        expect(NoteEventFeatures.readPlayCount(together[0])).toBe(3)
        expect(groupOf(apart[0])).not.toBe(groupOf(apart[1]))
        expect(NoteEventFeatures.readPlayCount(apart[0]), "split: false leaves the repeat behind").toBe(1)
    })
    it("takes the group along when the clipboard collects a note", () => {
        const {boxGraph, collection} = buildSkeleton()
        boxGraph.beginTransaction()
        const notes = [60, 64].map(pitch => createNote(boxGraph, collection, pitch))
        const group = NoteEventFeatures.group(notes, NoteEventFeatures.GroupMode.PlayAll).unwrap("group")
        boxGraph.endTransaction()
        const dependencies = Array.from(boxGraph.dependenciesOf(notes[0], {alwaysFollowMandatory: true}).boxes)
        expect(dependencies).toContain(NoteEventFeatures.chanceBox(notes[0]).unwrap("chance"))
        expect(dependencies).toContain(group)
        expect(dependencies).not.toContain(notes[1])
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
