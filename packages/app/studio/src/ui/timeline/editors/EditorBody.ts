import {Terminable} from "@moises-ai/lib-std"
import {attachWheelScroll} from "@/ui/timeline/editors/WheelScroll.ts"
import {installAutoScroll} from "@/ui/AutoScroll.ts"
import {Config} from "@/ui/timeline/Config.ts"
import {EventOwnerReader} from "./EventOwnerReader.ts"
import {TimelineRange} from "@moises-ai/studio-core"

export type Construct = {
    element: Element
    range: TimelineRange
    reader: EventOwnerReader<unknown>
}

export const installEditorBody = ({element, range, reader}: Construct): Terminable => {
    return Terminable.many(
        installEditorAuxBody(element, range),
        reader.keeoOverlapping(range)
    )
}

// This is for the extra editor that also needs wheel and auto-scroll support
// Currently: PropertyEditor within NoteEditor
export const installEditorAuxBody = (element: Element, range: TimelineRange): Terminable => {
    return Terminable.many(
        attachWheelScroll(element, range),
        installAutoScroll(element, (deltaX, _deltaY) => {
            if (deltaX !== 0) {range.moveUnitBy(deltaX * range.unitsPerPixel * Config.AutoScrollHorizontalSpeed)}
        }, {padding: Config.AutoScrollPadding})
    )
}