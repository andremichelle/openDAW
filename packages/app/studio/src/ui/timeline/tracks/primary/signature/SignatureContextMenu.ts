import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {ElementCapturing} from "../../../../../../../../studio/core/src/ui/canvas/capturing"
import {Parsing, SignatureEvent, SignatureTrackAdapter} from "@opendaw/studio-adapters"
import {EmptyExec} from "@opendaw/lib-std"
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
                            capturing: ElementCapturing<SignatureEvent>,
                            editing: BoxEditing,
                            trackAdapter: SignatureTrackAdapter) => {
        return ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const signature = capturing.captureEvent(client)
            if (signature === null) {return}
            const optAdapter = trackAdapter.adapterAt(signature.index)
            addItems(
                MenuItem.default({label: "Edit Signature"}).setTriggerProcedure(() => {
                    const resolvers = Promise.withResolvers<string>()
                    const clientRect = element.getBoundingClientRect()
                    Surface.get(element).flyout.appendChild(FloatingTextInput({
                        position: {
                            x: range.unitToX(signature.accumulatedPpqn) + clientRect.left,
                            y: clientRect.top + clientRect.height / 2
                        },
                        value: `${signature.nominator}/${signature.denominator}`,
                        resolvers
                    }))
                    resolvers.promise.then(value => {
                        const attempt = Parsing.parseTimeSignature(value)
                        if (attempt.isSuccess()) {
                            const [nominator, denominator] = attempt.result()
                            optAdapter.match<unknown>({
                                none: () => editing.modify(() => trackAdapter.changeSignature(nominator, denominator)),
                                some: adapter => {
                                    editing.modify(() => {
                                        const {box} = adapter
                                        box.nominator.setValue(nominator)
                                        box.denominator.setValue(denominator)
                                    })
                                }
                            })
                        }
                    }, EmptyExec)
                }),
                MenuItem.default({label: "Presets"}).setRuntimeChildrenProcedure(parent => {
                    parent.addMenuItem(
                        ...PresetSignatures.map(([nominator, denominator]) => MenuItem.default({
                            label: `${nominator}/${denominator}`,
                            checked: signature.nominator === nominator && signature.denominator === denominator
                        }).setTriggerProcedure(() => {
                            optAdapter.match<unknown>({
                                none: () => editing.modify(() => trackAdapter.changeSignature(nominator, denominator)),
                                some: adapter => {
                                    editing.modify(() => {
                                        const {box} = adapter
                                        box.nominator.setValue(nominator)
                                        box.denominator.setValue(denominator)
                                    })
                                }
                            })
                        }))
                    )
                })
            )
            if (optAdapter.nonEmpty()) {
                addItems(
                    MenuItem.default({label: "Delete"}).setTriggerProcedure(() => optAdapter.ifSome(adapter =>
                        editing.modify(() => trackAdapter.deleteAdapter(adapter)))),
                    DebugMenus.debugBox(optAdapter.unwrap().box))
            }
        })
    }
}
