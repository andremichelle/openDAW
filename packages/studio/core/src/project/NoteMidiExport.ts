import {ArrayMultimap, int} from "@opendaw/lib-std"
import {EventCollection, EventSpan, NoteEvent, PPQN, ppqn} from "@opendaw/lib-dsp"
import {Channel, ControlEvent, ControlType, MidiFile, MidiTrack} from "@opendaw/lib-midi"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {NoteEventCollectionBoxAdapter} from "@opendaw/studio-adapters"

export namespace NoteMidiExport {
    export const fromCollection = <E extends NoteEvent>(collection: EventCollection<E>): MidiTrack => {
        const events: Array<ControlEvent> = []
        const toTicks = (position: ppqn, timeDivision: int = 96): int => Math.floor(position / PPQN.Quarter * timeDivision)
        for (const event of collection.asArray()) {
            events.push(new ControlEvent(toTicks(event.position), ControlType.NOTE_ON, event.pitch, Math.round(event.velocity * 127)))
            events.push(new ControlEvent(toTicks(EventSpan.complete(event)), ControlType.NOTE_OFF, event.pitch, 0))
        }
        return new MidiTrack(new ArrayMultimap<Channel, ControlEvent>([[0, events]], ControlEvent.Comparator), [])
    }

    export const toFile = async (collection: NoteEventCollectionBoxAdapter, suggestedName: string = "notes.mid") => {
        const encoder = MidiFile.encoder()
        encoder.addTrack(fromCollection(collection.events))
        return Promises.tryCatch(Files.save(encoder.encode().toArrayBuffer() as ArrayBuffer, {
            types: [{
                description: "Midi File",
                accept: {"application/octet-stream": [".mid", ".midi"]}
            }], suggestedName
        }))
    }
}