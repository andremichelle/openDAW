import css from "./AudioCompositeEntry.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, MutableObservableValue, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AudioEffectCompositeCellBoxAdapter} from "@opendaw/studio-adapters"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Knob} from "@/ui/components/Knob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs.ts"
import {CompositeEntryDrop} from "@/ui/devices/CompositeEntryDrop"
import {AudioCompositeEntryReorder} from "@/ui/devices/AudioCompositeEntryReorder"
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

// ONE parallel branch of an AudioComposite: its gain / pan knobs, mute / solo, and a click target that ENTERS
// the branch (the device panel then shows that entry's own chain, as entering a Playfield slot does). The row
// is also a DROP TARGET, so an effect / preset can be dragged straight into it. Its own file and sass, so a
// branch is styled on its own.
export const AudioCompositeEntry = ({lifecycle, service, entry, fixed}: Construct) => {
    const {project} = service
    const {editing, midiLearning, userEditingManager} = project
    // The composite this entry belongs to — used for its automation tracks (an entry resolves to that same
    // owning unit) and for reindexing on delete.
    const composite = entry.compositeDevice()
    const tracks = entry.audioUnitBoxAdapter().tracks
    const label = entry.label.length === 0 ? `Entry ${entry.indexField.getValue() + 1}` : entry.label
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    const remove: HTMLElement = fixed ? <div/> : <Icon symbol={IconSymbol.Delete} className="remove"/>
    // The label doubles as the reorder DRAG HANDLE (see below): the knobs keep their own pointer dragging, so
    // the handle must be an element that carries no control of its own.
    const labelElement: HTMLElement = <div className="label">{label}</div>
    // Bare Knob + Checkbox built exactly as the track header's channel controls, so a branch reads the same as
    // its track. AutomationControl still gives automation, midi-learn, and the parameter menu.
    const element: HTMLElement = (
        <div className={className}>
            {labelElement}
            <div className="knob" data-swallow-click="">
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={entry.namedParameter.gain} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={entry.namedParameter.gain} options={SnapCommonDecibel}>
                        <Knob lifecycle={lifecycle} value={entry.namedParameter.gain} anchor={0.0}
                              color={Colors.yellow}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
            </div>
            <div className="knob" data-swallow-click="">
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={entry.namedParameter.pan} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={entry.namedParameter.pan} options={SnapCenter}>
                        <Knob lifecycle={lifecycle} value={entry.namedParameter.pan} anchor={0.5} color={Colors.green}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
            </div>
            <div className="checkboxes" data-swallow-click="">
                <Checkbox lifecycle={lifecycle} model={muteValue}
                          appearance={{activeColor: Colors.red, framed: true, tooltip: "Mute entry"}}>
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
    // A branch that holds effects reads brighter than an empty (pass-through) one.
    if (entry.audioEffects.mapOr(chain => chain.adapters().length, 0) > 0) {
        element.classList.add("has-effects")
    }
    lifecycle.ownAll(
        connectBoolean(muteValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.mute)),
        connectBoolean(soloValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.solo)),
        TextTooltip.default(element, () => "Edit entry chain"),
        // The knobs and checkboxes live INSIDE the row: swallow their clicks, so adjusting a control does not
        // also open the chain.
        Events.subscribe(element, "click", (event: Event) => {
            const target = event.target
            if (target instanceof Element && isDefined(target.closest("[data-swallow-click]"))) {
                event.stopPropagation()
            }
        }, {capture: true}),
        // Clicking the ROW opens its chain (opening the branch is the primary action, so it needs no button).
        Events.subscribe(element, "click", () => userEditingManager.audioUnit.edit(entry.box)),
        CompositeEntryDrop.install({element, project, chainField: entry.box.audioEffects, accepts: "audio"})
    )
    if (!fixed) {
        const getIndex = () => entry.indexField.getValue()
        lifecycle.ownAll(
            TextTooltip.default(remove, () => "Delete entry"),
            Events.subscribe(remove, "click", (event: Event) => {
                event.stopPropagation() // deleting must not also enter the row being deleted
                // Deleting the cell CASCADES to the effects it hosts (their `host` is mandatory), so a branch's
                // chain goes with it. The survivors are captured BEFORE the delete and reindexed to stay
                // 0..n-1 — the engine reads that index as the entry's order.
                const survivors = composite.entries.adapters().filter(other => other !== entry)
                editing.modify(() => {
                    entry.box.delete()
                    survivors.forEach((other, index) => other.indexField.setValue(index))
                })
            }),
            // Drag the label to reorder: the handle is the SOURCE, the whole row is the drop TARGET. A fixed
            // (split) composite maps entries by index, so it gets neither.
            AudioCompositeEntryReorder.installSource({
                handle: labelElement, classReceiver: element, composite, uuid: entry.uuid, getIndex
            }),
            AudioCompositeEntryReorder.installTarget({element, project, composite, getIndex})
        )
    }
    return element
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