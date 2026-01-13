import {MenuCollector, MenuItem} from "@moises-ai/studio-core"
import {Procedure} from "@moises-ai/lib-std"
import {NoteEventBoxAdapter} from "@moises-ai/studio-adapters"
import {EventCollection} from "@moises-ai/lib-dsp"
import {TimelineRange} from "@moises-ai/studio-core"
import {PitchPositioner} from "@/ui/timeline/editors/notes/pitch/PitchPositioner.ts"

import {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"

const NoteSizes = {
    "Small": 8,
    "Default": 11,
    "Big": 14,
    "Large": 17
} as const

export const installNoteViewMenu = (range: TimelineRange,
                                    owner: NoteEventOwnerReader,
                                    pitchPositioner: PitchPositioner,
                                    events: EventCollection<NoteEventBoxAdapter>): Procedure<MenuCollector> => {
    return (collector) => collector.addItems(
        MenuItem.default({label: "Set Note Height"})
            .setRuntimeChildrenProcedure(parent => {
                Object.entries(NoteSizes).forEach(([key, value]) => parent
                    .addMenuItem(MenuItem.default({label: key, checked: value === pitchPositioner.noteHeight})
                        .setTriggerProcedure(() => pitchPositioner.noteHeight = value)))
            }),
        MenuItem.default({label: "Zoom To All Notes", selectable: !events.isEmpty()})
            .setTriggerProcedure(() => {
                if (events.isEmpty()) {return}
                const [min, max] = events.asArray().reduce((minmax, adapter) => {
                    minmax[0] = Math.min(minmax[0], adapter.position)
                    minmax[1] = Math.max(minmax[1], adapter.complete)
                    return minmax
                }, [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
                range.zoomRange(min + owner.offset, max + owner.offset)
            })
    )
}