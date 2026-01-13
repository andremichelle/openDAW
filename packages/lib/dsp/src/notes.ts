import {Comparator, int, unitValue} from "@moises-ai/lib-std"
import {Event, EventSpan} from "./events"

export interface NoteEvent extends EventSpan {
    readonly type: "note-event"

    get pitch(): int
    get cent(): number
    get velocity(): unitValue
}

export namespace NoteEvent {
    export const isOfType = (event: Event): event is NoteEvent => event.type === "note-event"

    export const Comparator: Comparator<NoteEvent> = (a, b) => {
        const positionDiff = a.position - b.position
        if (positionDiff !== 0) {return positionDiff}
        const pitchDiff = a.pitch - b.pitch
        if (pitchDiff !== 0) {return pitchDiff}
        // We should allow this and leave it to the user to resolve issues like that
        return 0
    }

    export const curveFunc = (ratio: unitValue, curve: number): unitValue =>
        curve < 0.0 ? ratio ** (2.0 ** -curve) : 1.0 - (1.0 - ratio) ** (2.0 ** curve)

    export const inverseCurveFunc = (ratio: unitValue, curve: number): unitValue =>
        curve < 0.0 ? ratio ** (2.0 ** curve) : 1.0 - Math.max(0.0, 1.0 - ratio) ** (2.0 ** -curve)

    export const CompleteComparator: Comparator<NoteEvent> = (a: NoteEvent, b: NoteEvent) => {
        const diffComplete = EventSpan.complete(a) - EventSpan.complete(b)
        if (diffComplete !== 0) {return diffComplete}
        return a.pitch - b.pitch
    }
}