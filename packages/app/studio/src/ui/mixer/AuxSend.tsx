import css from "./AuxSend.sass?inline"
import {asInstanceOf, Color, DefaultObservableValue, Lifecycle, Option, StringComparator} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {AudioBusBoxAdapter, AudioUnitBoxAdapter, AuxSendBoxAdapter, ColorCodes} from "@opendaw/studio-adapters"
import {AudioUnitBox, AuxSendBox} from "@opendaw/studio-boxes"
import {AudioSendRouting, AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import {Knob, TinyDesign} from "@/ui/components/Knob.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {MenuItem, Project} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {IconCartridge} from "@/ui/components/Icon.tsx"
import {SnapCenter} from "@/ui/configs.ts"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "AuxSend")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    audioUnitAdapter: AudioUnitBoxAdapter
    adapter: AuxSendBoxAdapter
}

export const busColor = (bus: AudioBusBoxAdapter): Option<Color> => bus.box.output.targetVertex
    .map(vertex => ColorCodes.forAudioType(asInstanceOf(vertex.box, AudioUnitBox).type.getValue() as AudioUnitType))

export const sendTargets = (project: Project, audioUnitAdapter: AudioUnitBoxAdapter): ReadonlyArray<{bus: AudioBusBoxAdapter, selectable: boolean}> => {
    const currentAuxSends = audioUnitAdapter.auxSends.adapters()
    return project.rootBoxAdapter.audioBusses.adapters()
        .toSorted((left, right) => StringComparator(left.labelField.getValue(), right.labelField.getValue()))
        .filter(bus => !bus.deviceHost().audioUnitBoxAdapter().isOutput)
        .map(bus => ({
            bus, selectable: !currentAuxSends.some(send => send.targetBus.box.address.equals(bus.address))
                && project.grouping.canRoute([audioUnitAdapter.box], bus.deviceHost().audioUnitBoxAdapter().box)
        }))
}

export const AuxSend = ({lifecycle, project, audioUnitAdapter, adapter}: Construct) => {
    const {editing, userEditingManager} = project
    const tooltip = Inject.attribute(adapter.targetBus.labelField.getValue())
    lifecycle.own(adapter.targetBus.labelField.subscribe(owner => tooltip.value = owner.getValue()))
    const symbol = lifecycle.own(new DefaultObservableValue(IconSymbol.Rectangle))
    const target: HTMLElement = (
        <div className="target">
            <IconCartridge lifecycle={lifecycle} symbol={symbol} style={{fontSize: "12px"}}/>
        </div>
    )
    lifecycle.own(adapter.catchupAndSubscribeBusChanges(adapter => {
        adapter.match({
            none: () => {
                tooltip.value = "No Target"
                target.style.color = Colors.red.toString()
                symbol.setValue(IconSymbol.NoAudio)
            },
            some: (adapter) => {
                tooltip.value = adapter.labelField.getValue()
                busColor(adapter).ifSome(color => target.style.color = color.toString())
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
                .addMenuItem(adapter.optTargetBus.match({
                    none: () => MenuItem.header({label: "No Target", icon: IconSymbol.NoAudio, color: Colors.red}),
                    some: bus => MenuItem.header({label: bus.labelField.getValue(), icon: bus.iconSymbol, color: busColor(bus).unwrapOrUndefined()})
                }))
                .addMenuItem(MenuItem.default({label: "Edit", selectable: adapter.optTargetBus.nonEmpty()})
                    .setTriggerProcedure(() => adapter.optTargetBus.ifSome(bus =>
                        userEditingManager.audioUnit.edit(bus.deviceHost().audioUnitBoxAdapter().box.editing))))
                .addMenuItem(MenuItem.default({label: "Rewire"})
                    .setRuntimeChildrenProcedure(parent => parent.addMenuItem(...sendTargets(project, audioUnitAdapter)
                        .map(({bus, selectable}) => MenuItem.default({
                            label: bus.labelField.getValue(),
                            icon: bus.deviceHost().audioUnitBoxAdapter().input.icon,
                            checked: adapter.optTargetBus.mapOr(current => current.address.equals(bus.address), false),
                            selectable
                        }).setTriggerProcedure(() => editing.modify(() =>
                            asInstanceOf(adapter.box, AuxSendBox).targetBus.refer(bus.box.input)))))))
                .addMenuItem(MenuItem.default({label: "Routing"})
                    .setRuntimeChildrenProcedure(parent => {
                        const routing = adapter.routingField.getValue()
                        const item = (label: string, value: AudioSendRouting) => MenuItem.default({label, checked: routing === value})
                            .setTriggerProcedure(() => editing.modify(() => adapter.routingField.setValue(value)))
                        parent.addMenuItem(
                            item("Pre Fader", AudioSendRouting.Pre),
                            item("Post Fader", AudioSendRouting.Post)
                        )
                    }))
                .addMenuItem(MenuItem.default({label: `Remove Send '${adapter.targetBus.labelField.getValue()}'`})
                    .setTriggerProcedure(() => editing.modify(() => adapter.delete()))))}
                        style={{flex: "0 1 auto"}}
                        pointer>
                {target}
            </MenuButton>
        </div>
    )
}