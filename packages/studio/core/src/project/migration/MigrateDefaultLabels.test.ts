import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioUnitBox,
    NoteClipBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueClipBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {migrateDefaultLabels} from "./MigrateDefaultLabels"

const setup = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = ProjectSkeleton.empty({
        createDefaultUser: false, createOutputMaximizer: false
    })
    boxGraph.beginTransaction()
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(AudioUnitType.Instrument)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const createTrack = (type: TrackType, index: number): TrackBox =>
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(type)
            box.index.setValue(index)
            box.tracks.refer(unit.tracks)
            box.target.refer(unit)
        })
    const noteTrack = createTrack(TrackType.Notes, 0)
    const valueTrack = createTrack(TrackType.Value, 1)
    const createNoteRegion = (label: string): NoteRegionBox => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        return NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.duration.setValue(1920)
            box.loopDuration.setValue(1920)
            box.events.refer(events.owners)
            box.regions.refer(noteTrack.regions)
        })
    }
    const createNoteClip = (label: string, index: number): NoteClipBox => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        return NoteClipBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.index.setValue(index)
            box.duration.setValue(1920)
            box.events.refer(events.owners)
            box.clips.refer(noteTrack.clips)
        })
    }
    const createValueRegion = (label: string): ValueRegionBox => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.duration.setValue(1920)
            box.loopDuration.setValue(1920)
            box.events.refer(events.owners)
            box.regions.refer(valueTrack.regions)
        })
    }
    const createValueClip = (label: string, index: number): ValueClipBox => {
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return ValueClipBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue(label)
            box.index.setValue(index)
            box.duration.setValue(1920)
            box.events.refer(events.owners)
            box.clips.refer(valueTrack.clips)
        })
    }
    return {
        boxGraph, createNoteRegion, createNoteClip, createValueRegion, createValueClip,
        commit: () => boxGraph.endTransaction()
    }
}

describe("migrateDefaultLabels", () => {
    it("clears the hard-coded defaults on regions and clips", () => {
        const {boxGraph, createNoteRegion, createNoteClip, createValueRegion, createValueClip, commit} = setup()
        const noteRegion = createNoteRegion("Notes")
        const noteClip = createNoteClip("Notes", 0)
        const valueRegion = createValueRegion("Automation")
        const valueClip = createValueClip("Automation", 0)
        commit()

        migrateDefaultLabels(boxGraph)

        expect(noteRegion.label.getValue()).toBe("")
        expect(noteClip.label.getValue()).toBe("")
        expect(valueRegion.label.getValue()).toBe("")
        expect(valueClip.label.getValue()).toBe("")
    })

    it("keeps custom labels and never crosses region types", () => {
        const {boxGraph, createNoteRegion, createValueRegion, commit} = setup()
        const custom = createNoteRegion("Verse")
        const empty = createValueRegion("")
        const crossed = createNoteRegion("Automation")
        const crossedValue = createValueRegion("Notes")
        commit()

        migrateDefaultLabels(boxGraph)

        expect(custom.label.getValue()).toBe("Verse")
        expect(empty.label.getValue()).toBe("")
        expect(crossed.label.getValue()).toBe("Automation")
        expect(crossedValue.label.getValue()).toBe("Notes")
    })
})
