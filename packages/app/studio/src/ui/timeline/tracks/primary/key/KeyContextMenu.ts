import {ContextMenu, ElementCapturing, MenuItem} from "@opendaw/studio-core"
import {KeyEventBoxAdapter} from "@opendaw/studio-adapters"
import {Arrays, Editing} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {DebugMenus} from "@/ui/menu/debug"

export namespace KeyContextMenu {
    export const install = (element: Element, capturing: ElementCapturing<KeyEventBoxAdapter>, editing: Editing) =>
        ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const adapter = capturing.captureEvent(client)
            if (adapter === null) {return}
            addItems(
                MenuItem.default({label: "Root"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...Arrays.create(root => MenuItem.default({
                        label: MidiKeys.Names.English[root],
                        checked: root === adapter.root
                    }).setTriggerProcedure(() => editing.modify(() => adapter.box.root.setValue(root))), 12))),
                MenuItem.default({label: "Scale"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...MidiKeys.StockScales.map(scale => MenuItem.default({
                        label: scale.name,
                        checked: scale.bits === adapter.bits
                    }).setTriggerProcedure(() => editing.modify(() => adapter.box.scale.setValue(scale.bits)))))),
                MenuItem.default({label: "Delete"})
                    .setTriggerProcedure(() => editing.modify(() => adapter.box.delete())),
                DebugMenus.debugBox(adapter.box))
        })
}
