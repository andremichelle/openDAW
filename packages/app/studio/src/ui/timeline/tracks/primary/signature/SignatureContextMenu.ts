import {ContextMenu} from "@/ui/ContextMenu"
import {MenuItem} from "@/ui/model/menu-item"
import {ElementCapturing} from "@/ui/canvas/capturing"
import {Parsing, Signature, SignatureTrackAdapter} from "@opendaw/studio-adapters"
import {clamp, EmptyExec, int} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {DebugMenus} from "@/ui/menu/debug"
import {TimelineRange} from "@opendaw/studio-core"
import {Surface} from "@/ui/surface/Surface"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"

export namespace SignatureContextMenu {
    const PresetSignatures: ReadonlyArray<[number, number]> = [
        [4, 4], [3, 4], [2, 4], [6, 8], [5, 4], [7, 8], [12, 8]
    ] as const

    const findIndexForSignature = (trackAdapter: SignatureTrackAdapter, signature: Signature): int => {
        let index = 0
        for (const sig of trackAdapter.iterateAll()) {
            if (sig.accumulatedPpqn === signature.accumulatedPpqn) {return index}
            index++
        }
        return -1
    }

    export const install = (element: Element,
                            range: TimelineRange,
                            capturing: ElementCapturing<Signature>,
                            editing: BoxEditing,
                            trackAdapter: SignatureTrackAdapter) => {
        return ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const signature = capturing.captureEvent(client)
            if (signature === null) {return}

            const optAdapter = trackAdapter.adapterAt(findIndexForSignature(trackAdapter, signature))
            if (optAdapter.isEmpty()) {return}
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
                            if (optAdapter.isEmpty()) {return}
                            editing.modify(() => {
                                const {box} = optAdapter.unwrap()
                                box.nominator.setValue(clamp(nominator, 1, 32))
                                box.denominator.setValue(clamp(denominator, 1, 32))
                            })
                        }
                    }, EmptyExec)
                }),
                MenuItem.default({label: "Presets"}).setRuntimeChildrenProcedure(parent => {
                    parent.addMenuItem(
                        ...PresetSignatures.map(([nom, denom]) => MenuItem.default({
                            label: `${nom}/${denom}`,
                            checked: signature.nominator === nom && signature.denominator === denom
                        }).setTriggerProcedure(() => {
                            if (optAdapter.isEmpty()) {return}
                            editing.modify(() => {
                                const {box} = optAdapter.unwrap()
                                box.nominator.setValue(nom)
                                box.denominator.setValue(denom)
                            })
                        }))
                    )
                }),
                DebugMenus.debugBox(optAdapter.unwrap().box))
        })
    }
}
