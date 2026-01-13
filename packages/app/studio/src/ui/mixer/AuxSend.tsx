import css from "./AuxSend.sass?inline"
import {DefaultObservableValue, Lifecycle} from "@moises-ai/lib-std"
import {createElement, DomElement, Inject} from "@moises-ai/lib-jsx"
import {AuxSendBoxAdapter} from "@moises-ai/studio-adapters"
import {Colors, IconSymbol} from "@moises-ai/studio-enums"
import {Knob, TinyDesign} from "@/ui/components/Knob.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {MenuItem} from "@moises-ai/studio-core"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {IconCartridge} from "@/ui/components/Icon.tsx"
import {SnapCenter} from "@/ui/configs.ts"
import {BoxEditing} from "@moises-ai/lib-box"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "AuxSend")

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    adapter: AuxSendBoxAdapter
}

export const AuxSend = ({lifecycle, editing, adapter}: Construct) => {
    const tooltip = Inject.attribute(adapter.targetBus.labelField.getValue())
    lifecycle.own(adapter.targetBus.labelField.subscribe(owner => tooltip.value = owner.getValue()))
    const symbol = lifecycle.own(new DefaultObservableValue(IconSymbol.Rectangle))
    const iconCartridge: DomElement = (
        <IconCartridge lifecycle={lifecycle} symbol={symbol} style={{fontSize: "1.25em"}}/>
    )
    lifecycle.own(adapter.catchupAndSubscribeBusChanges(adapter => {
        adapter.match({
            none: () => {
                tooltip.value = "No Target"
                iconCartridge.style.color = Colors.red.toString()
                symbol.setValue(IconSymbol.NoAudio)
            },
            some: (adapter) => {
                tooltip.value = adapter.labelField.getValue()
                iconCartridge.style.color = adapter.colorField.getValue()
                symbol.setValue(adapter.iconSymbol)
            }
        })
    }))
    return (
        <div className={className}>
            <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={adapter.sendPan}
                                       options={SnapCenter}>
                <Knob lifecycle={lifecycle} value={adapter.sendPan} anchor={0.5} color={Colors.green}
                      design={TinyDesign}/>
            </RelativeUnitValueDragging>
            <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={adapter.sendGain}>
                <Knob lifecycle={lifecycle} value={adapter.sendGain} anchor={0.0} color={Colors.yellow}
                      design={TinyDesign}/>
            </RelativeUnitValueDragging>
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent
                .addMenuItem(MenuItem.default({label: "Routing"})
                    .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                        MenuItem.default({label: "Post Pan"}),
                        MenuItem.default({label: "Post Fader"}),
                        MenuItem.default({label: "Pre Fader", checked: true})
                    )))
                .addMenuItem(MenuItem.default({label: `Remove Send '${adapter.targetBus.labelField.getValue()}'`})
                    .setTriggerProcedure(() => editing.modify(() => adapter.delete()))))}
                        style={{flex: "0 1 auto"}}
                        pointer>
                {iconCartridge}
            </MenuButton>
        </div>
    )
}