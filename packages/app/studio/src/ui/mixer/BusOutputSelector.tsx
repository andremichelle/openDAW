import css from "./OutputSelector.sass?inline"
import {assert, DefaultObservableValue, Lifecycle, Predicate, StringComparator, UUID} from "@opendaw/lib-std"
import {PointerField} from "@opendaw/lib-box"
import {AudioBusBoxAdapter, AudioBusFactory, AudioUnitOutput} from "@opendaw/studio-adapters"
import {AudioUnitType, Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {createElement, DomElement, Frag} from "@opendaw/lib-jsx"
import {IconCartridge} from "@/ui/components/Icon.tsx"
import {Html} from "@opendaw/lib-dom"
import {MenuItem, Project} from "@opendaw/studio-core"
import {showNewAudioBusOrAuxDialog} from "@/ui/dialogs"
import {MenuButton} from "@/ui/components/MenuButton"

const className = Html.adoptStyleSheet(css, "OutputSelector")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    output: AudioUnitOutput
    pointer: PointerField<Pointers.AudioOutput>
    selectable: Predicate<AudioBusBoxAdapter>
}

export const BusOutputSelector = ({lifecycle, project, output, pointer, selectable}: Construct) => {
    const label: HTMLElement = (<div className="label"/>)
    const symbol = lifecycle.own(new DefaultObservableValue(IconSymbol.NoAudio))
    const iconCartridge: DomElement = (
        <IconCartridge lifecycle={lifecycle}
                       symbol={symbol}
                       style={{fontSize: "1.25em", color: Colors.red.toString()}}/>
    )
    lifecycle.own(output.catchupAndSubscribe(adapter => {
        adapter.match({
            none: () => {
                label.textContent = "No Output"
                iconCartridge.style.color = Colors.red.toString()
                symbol.setValue(IconSymbol.NoAudio)
            },
            some: (adapter) => {
                const color = adapter.colorField.getValue()
                label.textContent = adapter.labelField.getValue()
                label.style.color = color
                iconCartridge.style.color = color
                symbol.setValue(IconSymbol.fromName(adapter.iconField.getValue()))
            }
        })
    }))
    return (
        <div className={className}>
            <MenuButton
                root={MenuItem.root()
                    .setRuntimeChildrenProcedure(parent => {
                        const outputUUID = output.adapter.unwrapOrNull()?.uuid ?? UUID.Lowest
                        parent
                            .addMenuItem(...project.rootBoxAdapter.audioBusses.adapters()
                                .toSorted((a, b) => StringComparator(a.labelField.getValue(), b.labelField.getValue()))
                                .map(bus => MenuItem.default({
                                    label: bus.labelField.getValue(),
                                    icon: bus.deviceHost().audioUnitBoxAdapter().input.icon,
                                    selectable: selectable(bus),
                                    checked: UUID.Comparator(bus.uuid, outputUUID) === 0
                                }).setTriggerProcedure(() =>
                                    project.editing.modify(() => pointer.refer(bus.box.input)))))
                            .addMenuItem(
                                MenuItem.default({
                                    label: "New Output Bus...",
                                    icon: IconSymbol.New,
                                    separatorBefore: true
                                }).setTriggerProcedure(() =>
                                    showNewAudioBusOrAuxDialog("Bus", ({name, icon}) =>
                                        project.editing.modify(() => {
                                            assert(project.primaryAudioBusBox.isAttached(), "primaryAudioBusBox not attached")
                                            const audioBusBox = AudioBusFactory.create(project.skeleton,
                                                name, icon, AudioUnitType.Bus, Colors.orange)
                                            pointer.refer(audioBusBox.input)
                                        }), IconSymbol.AudioBus)),
                                MenuItem.default({
                                    label: "No Output",
                                    selectable: pointer.nonEmpty()
                                }).setTriggerProcedure(() => project.editing.modify(() => pointer.defer()))
                            )
                    })}
                appearance={{color: Colors.dark}}
                stretch={true}>
                <Frag>
                    {label}
                    {iconCartridge}
                </Frag>
            </MenuButton>
        </div>
    )
}
