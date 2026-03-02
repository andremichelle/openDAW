import {ElementCapturing, TimelineRange} from "@opendaw/studio-core"
import {TimelineCoordinates, TimelineSelectableLocator} from "@/ui/timeline/TimelineSelectableLocator.ts"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {Iterables, ValueAxis} from "@opendaw/lib-std"
import {PitchCaptureTarget} from "@/ui/timeline/editors/notes/pitch/PitchEventCapturing.ts"
import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"

export const createPitchSelectionLocator = (owner: NoteEventOwnerReader,
                                            range: TimelineRange,
                                            valueAxis: ValueAxis,
                                            capturing: ElementCapturing<PitchCaptureTarget>)
    : TimelineSelectableLocator<NoteEventBoxAdapter> => ({
    selectable: (): Iterable<NoteEventBoxAdapter> =>
        owner.hasContent ? owner.content.events.asArray() : Iterables.empty(),

    selectableAt: ({u, v}: TimelineCoordinates): Iterable<NoteEventBoxAdapter> => {
        const capture = capturing.captureLocalPoint(range.unitToX(u), valueAxis.valueToAxis(v))
        return capture === null || capture.type === "loop-duration" ? Iterables.empty() : [capture.event]
    },

    selectablesBetween(begin: TimelineCoordinates, end: TimelineCoordinates): Iterable<NoteEventBoxAdapter> {
        if (!owner.hasContent) {return Iterables.empty()}
        const offset = owner.offset
        const v0 = Math.ceil(begin.v)
        const v1 = Math.ceil(end.v)
        const u0 = begin.u - offset
        const u1 = end.u - offset
        const result: Array<NoteEventBoxAdapter> = []
        const events = owner.content.events
        const array = events.asArray()
        const endIndex = events.ceilFirstIndex(u1)
        for (let i = 0; i < endIndex; i++) {
            const element = array[i]
            if (element.complete > u0 && element.pitch >= v0 && element.pitch <= v1) {
                result.push(element)
            }
        }
        return result
    }
})