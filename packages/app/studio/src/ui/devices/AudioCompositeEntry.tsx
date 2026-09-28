import css from "./AudioCompositeEntry.sass?inline"
import {isDefined, Lifecycle, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {AudioEffectCompositeCellBoxAdapter} from "@opendaw/studio-adapters"
import {EffectFactories} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {AudioCompositeEntryDnD} from "@/ui/devices/AudioCompositeEntryDnD"
import {EntryPeakMeter} from "@/ui/devices/EntryPeakMeter"
import {CompositeCellStrip} from "@/ui/devices/CompositeCellStrip"
import {CompositeRows} from "@/ui/devices/CompositeRows"
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
    const {editing, userEditingManager} = project
    const composite = entry.compositeDevice()
    const getIndex = () => entry.indexField.getValue()
    const remove: HTMLElement = fixed ? <div/> : <Icon symbol={IconSymbol.Close} className="remove"/>
    const iconsElement: HTMLElement = <div className="icons"/>
    const rebuildIcons = () => {
        Html.empty(iconsElement)
        entry.audioEffects.ifSome(collection => collection.adapters()
            .forEach(effect => iconsElement.appendChild(<Icon symbol={CompositeRows.effectIcon(effect.box, EffectFactories.AudioNamed)}/>)))
    }
    rebuildIcons()
    const indexLabel: HTMLElement = <div className="index"/>
    const element: HTMLElement = (
        <div className={Html.buildClassList(className, fixed && "fixed")} data-composite-row="">
            {indexLabel}
            {iconsElement}
            <EntryPeakMeter lifecycle={lifecycle} receiver={project.liveStreamReceiver} address={entry.address}/>
            <CompositeCellStrip lifecycle={lifecycle} project={project} cell={entry} noun="entry"/>
            {remove}
        </div>
    )
    lifecycle.ownAll(
        entry.indexField.catchupAndSubscribe(field => indexLabel.textContent = String(field.getValue() + 1)),
        entry.audioEffects.mapOr(collection => collection.subscribe({
            onAdd: rebuildIcons, onRemove: rebuildIcons, onReorder: rebuildIcons
        }), Terminable.Empty),
        Events.subscribe(element, "click", (event: Event) => {
            const target = event.target
            if (target instanceof Element && isDefined(target.closest("[data-swallow-click]"))) {return}
            userEditingManager.audioUnit.edit(entry.box)
        }),
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
