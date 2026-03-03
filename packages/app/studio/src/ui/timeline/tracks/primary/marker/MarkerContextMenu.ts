import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"
import {ElementCapturing} from "../../../../../../../../studio/core/src/ui/canvas/capturing"
import {MarkerBoxAdapter} from "@opendaw/studio-adapters"
import {Arrays, EmptyExec} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {DebugMenus} from "@/ui/menu/debug"
import {Markers} from "@/ui/timeline/tracks/primary/marker/Markers"
import {TimelineRange} from "@opendaw/studio-core"

export namespace MarkerContextMenu {
    export const install = (element: Element,
                            range: TimelineRange,
                            capturing: ElementCapturing<MarkerBoxAdapter>,
                            editing: BoxEditing) => {
        return ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const adapter = capturing.captureEvent(client)
            if (adapter === null) {return}
            addItems(
                MenuItem.default({label: "Rename"}).setRuntimeChildrenProcedure(parent => {
                    parent.addMenuItem(
                        MenuItem.default({label: "Custom"}).setTriggerProcedure(() => {
                                const resolvers = Promise.withResolvers<string>()
                                const clientRect = element.getBoundingClientRect()
                                Surface.get(element).flyout.appendChild(FloatingTextInput({
                                    position: {
                                        x: range.unitToX(adapter.position) + clientRect.left,
                                        y: clientRect.top + clientRect.height / 2
                                    },
                                    value: adapter.label,
                                    resolvers
                                }))
                                resolvers.promise.then(newName => editing.modify(() => adapter.box.label.setValue(newName)), EmptyExec)
                            }
                        ),
                        ...Markers.DefaultNames
                            .map((name, index) => MenuItem.default({
                                label: name,
                                separatorBefore: index === 0,
                                checked: name === adapter.label
                            }).setTriggerProcedure(() => editing.modify(() => adapter.box.label.setValue(name))))
                    )
                }),
                MenuItem.default({label: "Repeat"}).setRuntimeChildrenProcedure(parent => {
                    parent.addMenuItem(
                        MenuItem.default({label: "Infinite", checked: adapter.plays === 0})
                            .setTriggerProcedure(() => editing.modify(() => adapter.box.plays.setValue(0))),
                        ...Arrays.create(index => MenuItem.default({
                            label: String(index + 1),
                            checked: adapter.plays === index + 1
                        }).setTriggerProcedure(() => editing.modify(() => adapter.box.plays.setValue(index + 1))), 16)
                    )
                }),
                MenuItem.default({label: "Delete"})
                    .setTriggerProcedure(() => editing.modify(() => adapter.box.delete())),
                DebugMenus.debugBox(adapter.box))
        })
    }
}