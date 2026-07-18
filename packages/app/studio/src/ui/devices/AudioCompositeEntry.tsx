import css from "./AudioCompositeEntry.sass?inline"
import {
    DefaultObservableValue,
    isDefined,
    Lifecycle,
    MutableObservableValue,
    Optional,
    Terminable
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Box} from "@opendaw/lib-box"
import {Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AudioEffectCompositeCellBoxAdapter} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Knob} from "@/ui/components/Knob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs.ts"
import {AudioCompositeEntryDnD} from "@/ui/devices/AudioCompositeEntryDnD"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "AudioCompositeEntry")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    entry: AudioEffectCompositeCellBoxAdapter
    // A SPLIT owns its entries (the engine maps them BY INDEX), so a fixed entry offers no delete.
    fixed: boolean
}

export const AudioCompositeEntry = ({lifecycle, service, entry, fixed}: Construct) => {
    const {project} = service
    const {editing, midiLearning, userEditingManager} = project
    const composite = entry.compositeDevice()
    const tracks = entry.audioUnitBoxAdapter().tracks
    const getIndex = () => entry.indexField.getValue()
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    const remove: HTMLElement = fixed ? <div/> : <Icon symbol={IconSymbol.Close} className="remove"/>
    const iconsElement: HTMLElement = <div className="icons"/>
    const rebuildIcons = () => {
        Html.empty(iconsElement)
        entry.audioEffects.ifSome(collection => collection.adapters()
            .forEach(effect => iconsElement.appendChild(<Icon symbol={effectIcon(effect.box)}/>)))
    }
    rebuildIcons()
    const indexLabel: HTMLElement = <div className="index"/>
    const element: HTMLElement = (
        <div className={className}>
            {indexLabel}
            {iconsElement}
            <div className="channel-mix" data-swallow-click="">
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={entry.namedParameter.gain} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={entry.namedParameter.gain} options={SnapCommonDecibel}>
                        <Knob lifecycle={lifecycle} value={entry.namedParameter.gain} anchor={0.0} color={Colors.yellow}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={entry.namedParameter.pan} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={entry.namedParameter.pan} options={SnapCenter}>
                        <Knob lifecycle={lifecycle} value={entry.namedParameter.pan} anchor={0.5} color={Colors.green}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
            </div>
            <div className="channel-isolation" data-swallow-click="">
                <Checkbox lifecycle={lifecycle} model={muteValue}
                          appearance={{activeColor: Colors.orange, framed: true, tooltip: "Mute entry"}}>
                    <Icon symbol={IconSymbol.Mute}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={soloValue}
                          appearance={{activeColor: Colors.yellow, framed: true, tooltip: "Solo entry"}}>
                    <Icon symbol={IconSymbol.Solo}/>
                </Checkbox>
            </div>
            {remove}
        </div>
    )
    lifecycle.ownAll(
        entry.indexField.catchupAndSubscribe(field => indexLabel.textContent = String(field.getValue() + 1)),
        connectBoolean(muteValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.mute)),
        connectBoolean(soloValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.solo)),
        entry.audioEffects.mapOr(collection => collection.subscribe({
            onAdd: rebuildIcons, onRemove: rebuildIcons, onReorder: rebuildIcons
        }), Terminable.Empty),
        Events.subscribe(element, "click", (event: Event) => {
            const target = event.target
            if (target instanceof Element && isDefined(target.closest("[data-swallow-click]"))) {
                event.stopPropagation()
            }
        }, {capture: true}),
        Events.subscribe(element, "click", () => userEditingManager.audioUnit.edit(entry.box)),
        AudioCompositeEntryDnD.installTarget({element, project, composite, entry, getIndex, branchable: !fixed})
    )
    if (!fixed) {
        lifecycle.ownAll(
            TextTooltip.default(remove, () => "Delete entry"),
            Events.subscribe(remove, "click", (event: Event) => {
                event.stopPropagation() // deleting must not also enter the row being deleted
                const survivors = composite.entries.adapters().filter(other => other !== entry)
                editing.modify(() => {
                    entry.box.delete()
                    survivors.forEach((other, index) => other.indexField.setValue(index))
                })
            }),
            AudioCompositeEntryDnD.installHandle({
                handle: iconsElement, classReceiver: element, composite, uuid: entry.uuid, getIndex
            })
        )
    }
    return element
}

const effectIcon = (box: Box): IconSymbol => {
    const key = box.name.replace(/DeviceBox$/, "").replace(/Box$/, "")
    const factory: Optional<EffectFactory> = (EffectFactories.AudioNamed as Record<string, EffectFactory>)[key]
    return isDefined(factory) ? factory.defaultIcon : IconSymbol.Effects
}

// Two-way bind a checkbox model to its parameter wrapper (mirrors the Playfield slot's own helper).
const connectBoolean = (value: MutableObservableValue<boolean>,
                        wrapper: MutableObservableValue<boolean>): Terminable => {
    value.setValue(wrapper.getValue())
    return Terminable.many(
        value.subscribe(owner => wrapper.setValue(owner.getValue())),
        wrapper.subscribe(owner => value.setValue(owner.getValue()))
    )
}