import {isDefined, Nullable} from "@opendaw/lib-std"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {PitchPositioner} from "@/ui/timeline/editors/notes/pitch/PitchPositioner.ts"
import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"

import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"

export type PitchCaptureTarget =
    | { type: "note-end", event: NoteEventBoxAdapter }
    | { type: "note-position", event: NoteEventBoxAdapter }
    | { type: "loop-duration", reader: NoteEventOwnerReader }

export const createPitchEventCapturing = (element: Element,
                                          positioner: PitchPositioner,
                                          range: TimelineRange,
                                          reader: NoteEventOwnerReader) =>
    new ElementCapturing<PitchCaptureTarget>(element, {
        capture: (x: number, y: number): Nullable<PitchCaptureTarget> => {
            const offset = reader.offset
            const pitch = positioner.yToPitch(y)
            const localPosition = Math.floor(range.xToUnit(x)) - offset
            const event = reader.content.events.lowerEqual(localPosition, event => event.pitch === pitch)
            if (isDefined(event)) {
                if (Math.abs(range.unitToX(event.complete + offset) - x) < PointerRadiusDistance) {
                    return {event, type: "note-end"}
                }
                if (localPosition < event.complete) {
                    return {event, type: "note-position"}
                }
            }
            return Math.abs(range.unitToX(reader.loopDuration + offset) - x) < PointerRadiusDistance
                ? {reader, type: "loop-duration"}
                : null
        }
    })