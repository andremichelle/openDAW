import css from "./AudioCompositeEntry.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, MutableObservableValue, Optional, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Box} from "@opendaw/lib-box"
import {Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {InstrumentCompositeCellBoxAdapter} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Knob} from "@/ui/components/Knob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs.ts"
import {EntryPeakMeter} from "@/ui/devices/EntryPeakMeter"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "AudioCompositeEntry")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    layer: InstrumentCompositeCellBoxAdapter
}

// One LAYER row of an Instrument Composite: its instrument and effect icons, meter, strip, and the way in.
export const InstrumentCompositeLayer = ({lifecycle, service, layer}: Construct) => {
    const {project} = service
    const {editing, midiLearning, userEditingManager, api} = project
    const tracks = layer.audioUnitBoxAdapter().tracks
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    const remove: HTMLElement = <Icon symbol={IconSymbol.Close} className="remove"/>
    const iconsElement: HTMLElement = <div className="icons"/>
    const rebuildIcons = () => {
        Html.empty(iconsElement)
        iconsElement.appendChild(<Icon symbol={layer.input.icon}/>)
        layer.audioEffects.ifSome(collection => collection.adapters()
            .forEach(effect => iconsElement.appendChild(<Icon symbol={effectIcon(effect.box)}/>)))
    }
    const indexLabel: HTMLElement = <div className="index"/>
    const element: HTMLElement = (
        <div className={className}>
            {indexLabel}
            {iconsElement}
            <EntryPeakMeter lifecycle={lifecycle} receiver={project.liveStreamReceiver} address={layer.address}/>
            <div className="channel-mix" data-swallow-click="">
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={layer.namedParameter.gain} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={layer.namedParameter.gain} options={SnapCommonDecibel}>
                        <Knob lifecycle={lifecycle} value={layer.namedParameter.gain} anchor={0.0} color={Colors.yellow}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={layer.namedParameter.pan} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={layer.namedParameter.pan} options={SnapCenter}>
                        <Knob lifecycle={lifecycle} value={layer.namedParameter.pan} anchor={0.5} color={Colors.green}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
            </div>
            <div className="channel-isolation" data-swallow-click="">
                <Checkbox lifecycle={lifecycle} model={muteValue}
                          appearance={{activeColor: Colors.orange, framed: true, tooltip: "Mute layer"}}>
                    <Icon symbol={IconSymbol.Mute}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={soloValue}
                          appearance={{activeColor: Colors.yellow, framed: true, tooltip: "Solo layer"}}>
                    <Icon symbol={IconSymbol.Solo}/>
                </Checkbox>
            </div>
            {remove}
        </div>
    )
    lifecycle.ownAll(
        layer.indexField.catchupAndSubscribe(field => indexLabel.textContent = String(field.getValue() + 1)),
        layer.input.iconValue.catchupAndSubscribe(rebuildIcons),
        connectBoolean(muteValue, EditWrapper.forAutomatableParameter(editing, layer.namedParameter.mute)),
        connectBoolean(soloValue, EditWrapper.forAutomatableParameter(editing, layer.namedParameter.solo)),
        layer.audioEffects.mapOr(collection => collection.subscribe({
            onAdd: rebuildIcons, onRemove: rebuildIcons, onReorder: rebuildIcons
        }), Terminable.Empty),
        TextTooltip.default(element, () => layer.label),
        Events.subscribe(element, "click", (event: Event) => {
            const target = event.target
            if (target instanceof Element && isDefined(target.closest("[data-swallow-click]"))) {return}
            userEditingManager.audioUnit.edit(layer.box)
        }),
        TextTooltip.default(remove, () => "Delete layer"),
        Events.subscribe(remove, "click", (event: Event) => {
            event.stopPropagation()
            editing.modify(() => api.deleteCompositeLayer(layer.box))
        })
    )
    return element
}

const effectIcon = (box: Box): IconSymbol => {
    const key = box.name.replace(/DeviceBox$/, "").replace(/Box$/, "")
    const factory: Optional<EffectFactory> = (EffectFactories.AudioNamed as Record<string, EffectFactory>)[key]
    return isDefined(factory) ? factory.defaultIcon : IconSymbol.Effects
}

const connectBoolean = (value: MutableObservableValue<boolean>,
                        wrapper: MutableObservableValue<boolean>): Terminable => {
    value.setValue(wrapper.getValue())
    return Terminable.many(
        value.subscribe(owner => wrapper.setValue(owner.getValue())),
        wrapper.subscribe(owner => value.setValue(owner.getValue()))
    )
}
