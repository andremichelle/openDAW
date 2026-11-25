import {describe, expect, it} from "vitest"
import {EventCollection, NoteEvent} from "@opendaw/lib-dsp"
import {ControlType} from "@opendaw/lib-midi"
import {NoteMidiExport} from "./NoteMidiExport"

const note = (position: number, velocity: number): NoteEvent =>
    ({type: "note-event", position, duration: 96, pitch: 60, cent: 0, velocity})

describe("NoteMidiExport", () => {
    it("never writes a note-on with velocity 0, which MIDI reads as a note-off", () => {
        const collection = EventCollection.create<NoteEvent>(NoteEvent.Comparator)
        collection.add(note(0, 0.0))
        collection.add(note(960, 1.0))
        const velocities = NoteMidiExport.fromCollection(collection).controlEvents.get(0)
            .filter(event => event.type === ControlType.NOTE_ON)
            .map(event => event.param1)
        expect(velocities).toEqual([1, 127])
    })
})
