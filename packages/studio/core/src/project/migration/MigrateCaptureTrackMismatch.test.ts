import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioUnitBox,
    CaptureAudioBox,
    CaptureMidiBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {migrateCaptureTrackMismatch} from "./MigrateCaptureTrackMismatch"

const setup = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = ProjectSkeleton.empty({
        createDefaultUser: false, createOutputMaximizer: false
    })
    boxGraph.beginTransaction()
    let nextIndex = 1
    const createUnit = (capture: CaptureMidiBox | CaptureAudioBox): AudioUnitBox =>
        AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(AudioUnitType.Instrument)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.capture.refer(capture)
            box.index.setValue(nextIndex++)
        })
    const createTrack = (unit: AudioUnitBox, type: TrackType): TrackBox =>
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(type)
            box.tracks.refer(unit.tracks)
            box.target.refer(unit)
        })
    const createNoteRegion = (track: TrackBox): NoteRegionBox => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        return NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(1920)
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
        })
    }
    return {boxGraph, createUnit, createTrack, createNoteRegion, commit: () => boxGraph.endTransaction()}
}

describe("migrateCaptureTrackMismatch", () => {
    it("kills the note structure on a Tape (audio-capture) unit", () => {
        const {boxGraph, createUnit, createTrack, createNoteRegion, commit} = setup()
        const capture = CaptureAudioBox.create(boxGraph, UUID.generate())
        const unit = createUnit(capture)
        const noteTrack = createTrack(unit, TrackType.Notes)
        const region = createNoteRegion(noteTrack)
        const events = region.events.targetVertex.unwrap("events").box
        const audioTrack = createTrack(unit, TrackType.Audio)
        const automation = createTrack(unit, TrackType.Value)
        commit()

        migrateCaptureTrackMismatch(boxGraph)

        expect(noteTrack.isAttached()).toBe(false)
        expect(region.isAttached()).toBe(false) // cascaded
        expect(events.isAttached()).toBe(false) // cascaded
        expect(audioTrack.isAttached()).toBe(true) // matches the capture
        expect(automation.isAttached()).toBe(true) // automation is kept on any unit
    })

    it("kills the audio structure on a MIDI (midi-capture) unit", () => {
        const {boxGraph, createUnit, createTrack, commit} = setup()
        const capture = CaptureMidiBox.create(boxGraph, UUID.generate())
        const unit = createUnit(capture)
        const audioTrack = createTrack(unit, TrackType.Audio)
        const noteTrack = createTrack(unit, TrackType.Notes)
        commit()

        migrateCaptureTrackMismatch(boxGraph)

        expect(audioTrack.isAttached()).toBe(false)
        expect(noteTrack.isAttached()).toBe(true)
    })

    it("is a no-op when the tracks match the capture", () => {
        const {boxGraph, createUnit, createTrack, createNoteRegion, commit} = setup()
        const unit = createUnit(CaptureMidiBox.create(boxGraph, UUID.generate()))
        const noteTrack = createTrack(unit, TrackType.Notes)
        const region = createNoteRegion(noteTrack)
        commit()

        migrateCaptureTrackMismatch(boxGraph)

        expect(noteTrack.isAttached()).toBe(true)
        expect(region.isAttached()).toBe(true)
    })
})
