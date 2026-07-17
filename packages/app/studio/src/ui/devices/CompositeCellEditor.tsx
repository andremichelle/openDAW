import css from "./CompositeCellEditor.sass?inline"
import {DefaultObservableValue, Lifecycle, MutableObservableValue, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Vertex} from "@opendaw/lib-box"
import {Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {AudioEffectCompositeCellBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Knob} from "@/ui/components/Knob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs.ts"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "CompositeCellEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    host: DeviceHost
}

// Shown in the instrument slot while a composite ENTRY is edited: the way BACK to the parent composite plus the
// entry's own gain / pan / mute / solo, matching the entry row's controls.
export const CompositeCellEditor = ({lifecycle, service, host}: Construct) => {
    const {editing, midiLearning, userEditingManager} = service.project
    // A composite CELL accepts the Editing pointer at the box level; an AUDIO UNIT only through its `editing`.
    const parent = host.deviceHost()
    const backTarget: Vertex<Pointers> = parent instanceof AudioEffectCompositeCellBoxAdapter
        ? parent.box
        : parent.audioUnitBoxAdapter().box.editing
    const entry = host instanceof AudioEffectCompositeCellBoxAdapter ? host : null
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    // The parent composite's name as a clickable pill (with a back arrow) that goes back, like the Playfield.
    const name: HTMLElement = <span className="device-name" style={{backgroundColor: Colors.blue.toString()}}/>
    const back: HTMLElement = (
        <div className="back">
            <Icon symbol={IconSymbol.ArrowLeft}/>
            {name}
        </div>
    )
    const header: HTMLElement = <h1 className="header">{back}</h1>
    const controls = entry === null ? <div/> : (
        <div className="controls">
            <div className="channel-mix">
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={entry.audioUnitBoxAdapter().tracks} parameter={entry.namedParameter.gain} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={entry.namedParameter.gain} options={SnapCommonDecibel}>
                        <Knob lifecycle={lifecycle} value={entry.namedParameter.gain} anchor={0.0} color={Colors.yellow}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={entry.audioUnitBoxAdapter().tracks} parameter={entry.namedParameter.pan} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={entry.namedParameter.pan} options={SnapCenter}>
                        <Knob lifecycle={lifecycle} value={entry.namedParameter.pan} anchor={0.5} color={Colors.green}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
            </div>
            <div className="channel-isolation">
                <Checkbox lifecycle={lifecycle} model={muteValue}
                          appearance={{activeColor: Colors.orange, framed: true, tooltip: "Mute entry"}}>
                    <Icon symbol={IconSymbol.Mute}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={soloValue}
                          appearance={{activeColor: Colors.yellow, framed: true, tooltip: "Solo entry"}}>
                    <Icon symbol={IconSymbol.Solo}/>
                </Checkbox>
            </div>
        </div>
    )
    const element: HTMLElement = <div className={className}>{header}{controls}</div>
    lifecycle.ownAll(
        TextTooltip.default(back, () => "Back to the parent chain"),
        Events.subscribe(back, "click", () => userEditingManager.audioUnit.edit(backTarget))
    )
    if (entry !== null) {
        lifecycle.ownAll(
            entry.compositeDevice().labelField.catchupAndSubscribe(owner => name.textContent = owner.getValue()),
            connectBoolean(muteValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.mute)),
            connectBoolean(soloValue, EditWrapper.forAutomatableParameter(editing, entry.namedParameter.solo))
        )
    } else {
        name.textContent = host.label
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
