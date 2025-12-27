import {ContextMenu} from "@/ui/ContextMenu"
import {MenuItem} from "@/ui/model/menu-item"
import {ElementCapturing} from "@/ui/canvas/capturing"
import {Parsing, SignatureEventBoxAdapter} from "@opendaw/studio-adapters"
import {clamp, EmptyExec} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {DebugMenus} from "@/ui/menu/debug"
import {TimelineRange} from "@opendaw/studio-core"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"

export namespace SignatureContextMenu {
    const PresetSignatures: ReadonlyArray<[number, number]> = [
        [4, 4], [3, 4], [2, 4], [6, 8], [5, 4], [7, 8], [12, 8]
    ] as const

    export const install = (element: Element,
                            range: TimelineRange,
                            capturing: ElementCapturing<SignatureEventBoxAdapter>,
                            editing: BoxEditing) => {
        return ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const adapter = capturing.captureEvent(client)
            if (adapter === null) {return}
            addItems(
                MenuItem.default({label: "Edit Signature"}).setTriggerProcedure(() => {
                    const resolvers = Promise.withResolvers<string>()
                    const clientRect = element.getBoundingClientRect()
                    Surface.get(element).flyout.appendChild(FloatingTextInput({
                        position: {
                            x: range.unitToX(adapter.position) + clientRect.left,
                            y: clientRect.top + clientRect.height / 2
                        },
                        value: `${adapter.nominator}/${adapter.denominator}`,
                        resolvers
                    }))
                    resolvers.promise.then(value => {
                        const attempt = Parsing.parseTimeSignature(value)
                        if (attempt.isSuccess()) {
                            const [nominator, denominator] = attempt.result()
                            editing.modify(() => {
                                adapter.box.nominator.setValue(clamp(nominator, 1, 32))
                                adapter.box.denominator.setValue(clamp(denominator, 1, 32))
                            })
                        }
                    }, EmptyExec)
                }),
                MenuItem.default({label: "Presets"}).setRuntimeChildrenProcedure(parent => {
                    parent.addMenuItem(
                        ...PresetSignatures.map(([nom, denom]) => MenuItem.default({
                            label: `${nom}/${denom}`,
                            checked: adapter.nominator === nom && adapter.denominator === denom
                        }).setTriggerProcedure(() => editing.modify(() => {
                            adapter.box.nominator.setValue(nom)
                            adapter.box.denominator.setValue(denom)
                        })))
                    )
                }),
                MenuItem.default({label: "Delete", separatorBefore: true})
                    .setTriggerProcedure(() => editing.modify(() => adapter.box.delete())),
                DebugMenus.debugBox(adapter.box))
        })
    }
}
