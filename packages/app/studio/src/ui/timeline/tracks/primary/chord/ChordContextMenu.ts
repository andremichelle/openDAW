import {ContextMenu, ElementCapturing, MenuItem} from "@opendaw/studio-core"
import {ChordEventBoxAdapter} from "@opendaw/studio-adapters"
import {Arrays, Editing, int, Procedure} from "@opendaw/lib-std"
import {Harmony} from "@opendaw/lib-dsp"
import {DebugMenus} from "@/ui/menu/debug"

export namespace ChordContextMenu {
    export const install = (element: Element,
                            capturing: ElementCapturing<ChordEventBoxAdapter>,
                            editing: Editing,
                            onChange: Procedure<ChordEventBoxAdapter>) =>
        ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const adapter = capturing.captureEvent(client)
            if (adapter === null) {return}
            const modify = (procedure: Procedure<ChordEventBoxAdapter>) => {
                editing.modify(() => procedure(adapter))
                onChange(adapter)
            }
            const shifts: ReadonlyArray<[string, int]> = [["♭ Lowered", -1], ["Natural", 0], ["♯ Raised", 1]]
            addItems(
                MenuItem.default({label: "Degree"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...Arrays.create(index => MenuItem.default({
                        label: String(index + 1),
                        checked: index + 1 === adapter.degree
                    }).setTriggerProcedure(() => modify(({box}) => box.degree.setValue(index + 1))), 7))),
                MenuItem.default({label: "Shift"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...shifts.map(([label, shift]) => MenuItem.default({label, checked: shift === adapter.shift})
                        .setTriggerProcedure(() => modify(({box}) => box.shift.setValue(shift)))))),
                MenuItem.default({label: "Shape"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({label: "From Scale", checked: adapter.shape === 0})
                        .setTriggerProcedure(() => modify(({box}) => box.shape.setValue(0))),
                    ...Harmony.ChordShapes.map((shape, index) => MenuItem.default({
                        label: shape.name,
                        checked: shape.bits === adapter.shape,
                        separatorBefore: index === 0
                    }).setTriggerProcedure(() => modify(({box}) => box.shape.setValue(shape.bits)))))),
                MenuItem.default({label: "Delete"})
                    .setTriggerProcedure(() => editing.modify(() => adapter.box.delete())),
                DebugMenus.debugBox(adapter.box))
        })
}
