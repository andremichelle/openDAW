import css from "./CompositeCellEditor.sass?inline"
import {DefaultObservableValue, Lifecycle, MutableObservableValue, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Vertex} from "@opendaw/lib-box"
import {Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {AudioEffectCompositeCellBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "CompositeCellEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    host: DeviceHost
}

// What the device panel shows in the INSTRUMENT slot while a composite ENTRY is being edited: an entry hosts no
// instrument (its signal comes from the composite), so the slot would otherwise be empty. It carries the way
// BACK out plus the entry's own bar controls (gain, pan, mute, solo), so they stay reachable while you edit the
// branch chain — the entry strip is a real ChannelStrip, so pan is a genuine control.
export const CompositeCellEditor = ({lifecycle, service, host}: Construct) => {
    const {editing, midiLearning, userEditingManager} = service.project
    const back: HTMLElement = <Icon symbol={IconSymbol.ArrowLeft} className="back"/>
    // Where BACK returns to: the immediate PARENT host (the composite's own host) — the audio unit for a
    // top-level entry, or the OUTER entry's chain when composites are nested. Going straight to the audio unit
    // would skip the intermediate composites. The vertex the editing pointer may target differs by host: a
    // composite CELL accepts the Editing pointer at the box level (like a Playfield slot), while an AUDIO UNIT
    // accepts it only through its `editing` FIELD — pointing at the unit box itself throws.
    const parent = host.deviceHost()
    const backTarget: Vertex<Pointers> = parent instanceof AudioEffectCompositeCellBoxAdapter
        ? parent.box
        : parent.audioUnitBoxAdapter().box.editing
    // The entry adapter, when this host IS a composite entry (it always is here) — for its bar controls.
    const entry = host instanceof AudioEffectCompositeCellBoxAdapter ? host : null
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    const controls = entry === null ? <div/> : (
        <div className="controls">
            {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter: entry.compositeDevice(), parameter: entry.namedParameter.gain})}
            {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter: entry.compositeDevice(), parameter: entry.namedParameter.pan})}
            <div className="checkboxes">
                <Checkbox lifecycle={lifecycle} model={muteValue}
                          appearance={{activeColor: Colors.red, framed: true, tooltip: "Mute entry"}}>
                    <Icon symbol={IconSymbol.Mute}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={soloValue}
                          appearance={{activeColor: Colors.yellow, framed: true, tooltip: "Solo entry"}}>
                    <Icon symbol={IconSymbol.Solo}/>
                </Checkbox>
            </div>
        </div>
    )
    const element: HTMLElement = (
        <div className={className}>
            <div className="header">
                {back}
                <div className="label">{host.label}</div>
            </div>
            {controls}
        </div>
    )
    lifecycle.ownAll(
        TextTooltip.default(back, () => "Back to the parent chain"),
        Events.subscribe(back, "click", () => userEditingManager.audioUnit.edit(backTarget))
    )
    if (entry !== null) {
        lifecycle.ownAll(
            connectBoolean(muteValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.mute)),
            connectBoolean(soloValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.solo))
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
