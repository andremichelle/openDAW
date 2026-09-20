import css from "./AudioCompositeEntry.sass?inline"
import {isDefined, Lifecycle, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {InstrumentCompositeCellBoxAdapter} from "@opendaw/studio-adapters"
import {EffectFactories} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {EntryPeakMeter} from "@/ui/devices/EntryPeakMeter"
import {CompositeCellStrip} from "@/ui/devices/CompositeCellStrip"
import {CompositeRows} from "@/ui/devices/CompositeRows"
import {InstrumentCompositeLayerDnD} from "@/ui/devices/InstrumentCompositeLayerDnD"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "AudioCompositeEntry")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    layer: InstrumentCompositeCellBoxAdapter
}

export const InstrumentCompositeLayer = ({lifecycle, service, layer}: Construct) => {
    const {project} = service
    const {editing, userEditingManager, api} = project
    const composite = layer.compositeDevice()
    const getIndex = () => layer.indexField.getValue()
    const remove: HTMLElement = <Icon symbol={IconSymbol.Close} className="remove"/>
    const iconsElement: HTMLElement = <div className="icons"/>
    const rebuildIcons = () => {
        Html.empty(iconsElement)
        layer.midiEffects.ifSome(collection => collection.adapters().forEach(effect => iconsElement.appendChild(
            <Icon symbol={CompositeRows.effectIcon(effect.box, EffectFactories.MidiNamed)} className="midi-effect"/>)))
        if (layer.inputAdapter.nonEmpty()) {
            iconsElement.appendChild(<Icon symbol={layer.input.icon} className="instrument"/>)
        }
        layer.audioEffects.ifSome(collection => collection.adapters().forEach(effect => iconsElement.appendChild(
            <Icon symbol={CompositeRows.effectIcon(effect.box, EffectFactories.AudioNamed)} className="audio-effect"/>)))
    }
    const indexLabel: HTMLElement = <div className="index"/>
    const element: HTMLElement = (
        <div className={className}>
            {indexLabel}
            {iconsElement}
            <EntryPeakMeter lifecycle={lifecycle} receiver={project.liveStreamReceiver} address={layer.address}/>
            <CompositeCellStrip lifecycle={lifecycle} project={project} cell={layer} noun="layer"/>
            {remove}
        </div>
    )
    lifecycle.ownAll(
        layer.indexField.catchupAndSubscribe(field => indexLabel.textContent = String(field.getValue() + 1)),
        layer.input.iconValue.catchupAndSubscribe(rebuildIcons),
        layer.midiEffects.mapOr(collection => collection.subscribe({
            onAdd: rebuildIcons, onRemove: rebuildIcons, onReorder: rebuildIcons
        }), Terminable.Empty),
        layer.audioEffects.mapOr(collection => collection.subscribe({
            onAdd: rebuildIcons, onRemove: rebuildIcons, onReorder: rebuildIcons
        }), Terminable.Empty),
        TextTooltip.default(element, () => layer.label),
        Events.subscribe(element, "click", (event: Event) => {
            const target = event.target
            if (target instanceof Element && isDefined(target.closest("[data-swallow-click]"))) {return}
            userEditingManager.audioUnit.edit(layer.box)
        }),
        InstrumentCompositeLayerDnD.installTarget({element, project, composite, layer, getIndex}),
        InstrumentCompositeLayerDnD.installHandle({
            handle: iconsElement, classReceiver: element, composite, uuid: layer.uuid, getIndex
        }),
        TextTooltip.default(remove, () => "Delete layer"),
        Events.subscribe(remove, "click", (event: Event) => {
            event.stopPropagation()
            editing.modify(() => api.deleteCompositeLayer(layer.box))
        })
    )
    return element
}
