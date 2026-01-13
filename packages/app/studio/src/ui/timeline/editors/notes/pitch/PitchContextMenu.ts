import {ContextMenu} from "@moises-ai/studio-core"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {BoxEditing} from "@moises-ai/lib-box"
import {MutableObservableValue, Selection} from "@moises-ai/lib-std"
import {NoteEventBoxAdapter} from "@moises-ai/studio-adapters"
import {PitchCaptureTarget} from "@/ui/timeline/editors/notes/pitch/PitchEventCapturing.ts"
import {createPitchMenu} from "@/ui/timeline/editors/notes/pitch/PitchMenu.ts"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {EventCollection} from "@moises-ai/lib-dsp"

type Construct = {
    element: Element
    capturing: ElementCapturing<PitchCaptureTarget>
    snapping: Snapping
    editing: BoxEditing
    selection: Selection<NoteEventBoxAdapter>
    events: EventCollection<NoteEventBoxAdapter>
    stepRecording: MutableObservableValue<boolean>
}

export const installContextMenu =
    ({element, capturing, snapping, editing, selection, events, stepRecording}: Construct) =>
        ContextMenu.subscribe(element, (collector: ContextMenu.Collector) => {
            const target = capturing.captureEvent(collector.client)
            if (target === null) {return}
            if ("event" in target && !selection.isSelected(target.event)) {
                selection.deselectAll()
                selection.select(target.event)
            }
            createPitchMenu({editing, snapping, selection, events, stepRecording})(collector)
        })