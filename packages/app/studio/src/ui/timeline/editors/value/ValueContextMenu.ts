import {ContextMenu, MenuItem} from "@moises-ai/studio-core"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {BoxEditing} from "@moises-ai/lib-box"
import {Objects, Selection} from "@moises-ai/lib-std"
import {ValueEventBoxAdapter} from "@moises-ai/studio-adapters"
import {ValueCaptureTarget} from "@/ui/timeline/editors/value/ValueEventCapturing.ts"
import {Interpolation} from "@moises-ai/lib-dsp"
import {DebugMenus} from "@/ui/menu/debug.ts"
import {ValueEventEditing} from "@/ui/timeline/editors/value/ValueEventEditing"

type Construct = {
    element: Element
    capturing: ElementCapturing<ValueCaptureTarget>
    editing: BoxEditing
    selection: Selection<ValueEventBoxAdapter>
}

export const installValueContextMenu = ({element, capturing, editing, selection}: Construct) =>
    ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
        const target = capturing.captureEvent(client)
        if (target === null || target.type === "loop-duration") {return}
        if ("event" in target && !selection.isSelected(target.event)) {
            selection.deselectAll()
            selection.select(target.event)
        }
        addItems(
            MenuItem.default({label: "Delete"})
                .setTriggerProcedure(() => editing.modify(() => selection.selected()
                    .forEach(adapter => ValueEventEditing.deleteEvent(adapter.collection.unwrap(), adapter)))),
            MenuItem.default({label: "Interpolation"})
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({
                        label: "None",
                        checked: target.event.interpolation.type === "none"
                    }).setTriggerProcedure(() => editing.modify(() => selection.selected()
                        .forEach(adapter => adapter.interpolation = Interpolation.None))),
                    MenuItem.default({
                        label: "Linear",
                        checked: target.event.interpolation.type === "linear"
                    }).setTriggerProcedure(() => editing.modify(() => selection.selected()
                        .forEach(adapter => adapter.interpolation = Interpolation.Linear))),
                    MenuItem.default({
                        label: "Curve",
                        checked: target.event.interpolation.type === "curve"
                    }).setTriggerProcedure(() => {
                        editing.modify(() => {
                            const interpolation = Interpolation.Curve(0.75)
                            selection.selected().forEach(adapter => adapter.interpolation = interpolation)
                        })
                    })
                )),
            MenuItem.default({label: "Print events to console"})
                .setTriggerProcedure(() => {
                    console.debug(JSON.stringify(target.event.collection.unwrap().events.asArray()
                        .map(event => Objects.include(event, "position", "value", "interpolation", "index"))))
                }),
            DebugMenus.debugBox(target.event.box)
        )
    })