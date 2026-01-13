import {Event, NoteEvent, ppqn} from "@moises-ai/lib-dsp"
import {byte, float, Id, int, Terminable} from "@moises-ai/lib-std"

export type NoteCompleteEvent = Id<Event & {
    readonly type: "note-complete-event"
    readonly pitch: byte
}>

export type NoteLifecycleEvent = Id<NoteEvent> | NoteCompleteEvent

export namespace NoteLifecycleEvent {
    // adjacent notes are independent
    export const Comparator = (a: NoteLifecycleEvent, b: NoteLifecycleEvent): number => {
        const delta = a.position - b.position
        if (delta !== 0) {return delta}
        if (a.type === "note-complete-event") {return -1}
        if (b.type === "note-complete-event") {return 1}
        return 0
    }

    export const start = (position: ppqn, duration: ppqn, pitch: byte, velocity: float, cent: number = 0.0): Id<NoteEvent> =>
        ({type: "note-event", position, duration, pitch, velocity, cent, id: ++$id})
    export const startWith = (source: NoteEvent, position?: ppqn, duration?: ppqn): Id<NoteEvent> => ({
        type: "note-event",
        position: position ?? source.position,
        duration: duration ?? source.duration,
        pitch: source.pitch,
        cent: source.cent,
        velocity: source.velocity,
        id: ++$id
    })
    export const stop = ({id, pitch}: Id<NoteEvent>, position: ppqn): NoteCompleteEvent =>
        ({type: "note-complete-event", position, pitch, id})
    export const isStart = (event: Event): event is Id<NoteEvent> =>
        event.type === "note-event" && "id" in event && typeof event.id === "number"
    export const isStop = (event: Event): event is NoteCompleteEvent =>
        event.type === "note-complete-event"
    let $id: int = 0 | 0
}

export interface NoteEventSource {
    // find all notes that start in a given interval and returns them moved into global time space
    processNotes(from: ppqn, to: ppqn, flags: int /*BlockFlag*/): IterableIterator<NoteLifecycleEvent>

    // find all active local notes at a given position
    iterateActiveNotesAt(position: ppqn, onlyExternal: boolean): IterableIterator<NoteEvent>
}

export interface NoteEventTarget {
    setNoteEventSource(source: NoteEventSource): Terminable
}