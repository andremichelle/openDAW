import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {isDefined, Nullable} from "@moises-ai/lib-std"
import {PointerRadiusDistance} from "@/ui/timeline/constants.ts"
import {PitchPositioner} from "@/ui/timeline/editors/notes/pitch/PitchPositioner.ts"
import {TimelineRange} from "@moises-ai/studio-core"
import {NoteEventBoxAdapter} from "@moises-ai/studio-adapters"

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
            return isDefined(event) && localPosition < event.complete
                ? range.unitToX(event.complete + offset) - x < PointerRadiusDistance * 2
                    ? {event, type: "note-end"}
                    : {event, type: "note-position"}
                : Math.abs(range.unitToX(reader.loopDuration + offset) - x) < PointerRadiusDistance
                    ? {reader, type: "loop-duration"}
                    : null
        }
    })