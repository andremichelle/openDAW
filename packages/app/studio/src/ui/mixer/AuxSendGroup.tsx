import css from "./AuxSendGroup.sass?inline"
import {
    asInstanceOf,
    isDefined,
    Lifecycle,
    MutableObservableValue,
    Optional,
    SortedSet,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {AudioBusFactory, AudioUnitBoxAdapter, AuxSendBoxAdapter} from "@opendaw/studio-adapters"
import {AudioSendRouting, AudioUnitType, Colors, IconSymbol} from "@opendaw/studio-enums"
import {AuxSend, sendTargets} from "@/ui/mixer/AuxSend.tsx"
import {createElement} from "@opendaw/lib-jsx"
import {MenuItem, Project} from "@opendaw/studio-core"
import {AuxSendBox, MasteringDeviceBox} from "@opendaw/studio-boxes"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Icon} from "../components/Icon"
import {showNewAudioBusOrAuxDialog} from "@/ui/dialogs.tsx"
import {Html} from "@opendaw/lib-dom"
import {Checkbox} from "@/ui/components/Checkbox"
import {TextTooltip} from "@/ui/surface/TextTooltip"

const className = Html.adoptStyleSheet(css, "AuxSendGroup")

type AuxSendEntry = {
    uuid: UUID.Bytes
    element: HTMLElement
    terminator: Terminator
}

type Construct = {
    lifecycle: Lifecycle
    project: Project
    audioUnitAdapter: AudioUnitBoxAdapter
    mastering?: MutableObservableValue<boolean>
}

export const AuxSendGroup = ({lifecycle, project, audioUnitAdapter, mastering}: Construct) => {
    const canHaveAuxSends = !audioUnitAdapter.isOutput
    const groupElement: HTMLDivElement = <div className={className}/>
    if (!canHaveAuxSends) {
        if (isDefined(mastering)) {
            groupElement.classList.add("mastering")
            groupElement.appendChild(
                <Checkbox lifecycle={lifecycle} model={mastering}
                          appearance={{color: Colors.orange, activeColor: Colors.blue}}>
                    <span>Mastering</span>
                </Checkbox>
            )
            const deviceLifecycle = lifecycle.own(new Terminator())
            const showState = (state: Optional<"mastered" | "bypassed">) => {
                groupElement.classList.toggle("mastered", state === "mastered")
                groupElement.classList.toggle("bypassed", state === "bypassed")
            }
            lifecycle.own(audioUnitAdapter.box.mastering.pointerHub.catchupAndSubscribe({
                onAdded: pointer => {
                    deviceLifecycle.terminate()
                    deviceLifecycle.own(asInstanceOf(pointer.box, MasteringDeviceBox).enabled
                        .catchupAndSubscribe(owner => showState(owner.getValue() ? "mastered" : "bypassed")))
                },
                onRemoved: () => {
                    deviceLifecycle.terminate()
                    showState(undefined)
                }
            }))
        }
        return groupElement
    }
    groupElement.classList.add("enabled")
    groupElement.appendChild(
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
            const currentAuxSends = audioUnitAdapter.auxSends.adapters()
            const availableSends = sendTargets(project, audioUnitAdapter)
                .map(({bus: auxSendAdapter, selectable}) => MenuItem.default({
                    label: auxSendAdapter.labelField.getValue(),
                    icon: auxSendAdapter.deviceHost().audioUnitBoxAdapter().input.icon,
                    selectable
                }).setTriggerProcedure(() => project.editing.modify(() => {
                    AuxSendBox.create(project.boxGraph, UUID.generate(), box => {
                        box.audioUnit.refer(audioUnitAdapter.box.auxSends)
                        box.routing.setValue(AudioSendRouting.Post)
                        box.sendGain.setValue(-6.0)
                        box.targetBus.refer(auxSendAdapter.box.input)
                        box.index.setValue(currentAuxSends.length)
                    })
                }, true)))
            parent
                .addMenuItem(...availableSends)
                .addMenuItem(MenuItem.default({
                    label: "New FX Bus...",
                    icon: IconSymbol.New,
                    separatorBefore: availableSends.length > 0
                })
                    .setTriggerProcedure(() => showNewAudioBusOrAuxDialog("FX", ({name, icon}) => {
                        const currentAuxSends = audioUnitAdapter.auxSends.adapters()
                        project.editing.modify(() => {
                            const audioBusBox = AudioBusFactory.create(project.skeleton,
                                name, icon, AudioUnitType.Aux, Colors.green)
                            AuxSendBox.create(project.boxGraph, UUID.generate(), box => {
                                box.audioUnit.refer(audioUnitAdapter.box.auxSends)
                                box.targetBus.refer(audioBusBox.input)
                                box.routing.setValue(AudioSendRouting.Post)
                                box.sendGain.setValue(-6.0)
                                box.index.setValue(currentAuxSends.length)
                            })
                        })
                    }, IconSymbol.Effects)))
        })} onInit={button => {
            button.classList.add("add")
            lifecycle.own(TextTooltip.default(button, () => "Add Send"))
            button.addEventListener("pointerdown", () =>
                project.userEditingManager.audioUnit.editIfDifferent(audioUnitAdapter.box.editing))
        }} pointer>
            <Icon symbol={IconSymbol.Add}/>
        </MenuButton>
    )
    const entries: SortedSet<UUID.Bytes, AuxSendEntry> = UUID.newSet(entry => entry.uuid)
    lifecycle.own(audioUnitAdapter.auxSends.catchupAndSubscribe({
        onAdd: (adapter: AuxSendBoxAdapter) => {
            const terminator = lifecycle.spawn()
            const element: HTMLElement = <AuxSend lifecycle={terminator}
                                                  project={project}
                                                  audioUnitAdapter={audioUnitAdapter}
                                                  adapter={adapter}/>
            groupElement.appendChild(element)
            entries.add({element, terminator, uuid: adapter.uuid})
        },
        onRemove: (adapter: AuxSendBoxAdapter) => {
            const {element, terminator} = entries.removeByKey(adapter.uuid)
            element.remove()
            terminator.terminate()
        },
        onReorder: (_adapter: AuxSendBoxAdapter) => {}
    }))
    return groupElement
}