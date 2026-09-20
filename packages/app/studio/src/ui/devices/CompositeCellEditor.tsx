import css from "./CompositeCellEditor.sass?inline"
import {DefaultObservableValue, Errors, Lifecycle, MutableObservableValue, Option, panic, Terminable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StringField, Vertex} from "@opendaw/lib-box"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {TextScroller} from "@/ui/TextScroller"
import {Surface} from "@/ui/surface/Surface"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {CompositeCell, DeviceHost} from "@opendaw/studio-adapters"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Knob} from "@/ui/components/Knob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs.ts"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {MenuButton} from "@/ui/components/MenuButton"
import {ClipboardManager, DevicesClipboard, MenuItem} from "@opendaw/studio-core"
import {MenuItems} from "@/ui/devices/menu-items"
import {DebugMenus} from "@/ui/menu/debug"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "CompositeCellEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    host: DeviceHost
}

export const CompositeCellEditor = ({lifecycle, service, host}: Construct) => {
    const {editing, midiLearning, userEditingManager, deviceSelection} = service.project
    const backTarget: Vertex<Pointers> = MenuItems.backTargetOfCell(host)
    const entry = host.asCompositeCell().unwrapOrNull()
    const labelFieldOf = (cell: CompositeCell): StringField => cell.compositeDevice().labelField
    const noun = entry?.cellKind === "instrument" ? "layer" : "entry"
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    const name: HTMLElement = (
        <h1 onInit={element => {
            lifecycle.ownAll(
                TextScroller.install(element),
                Events.subscribeDblDwn(element, async event => {
                    if (entry === null) {return}
                    const labelField = labelFieldOf(entry)
                    const {status, error, value} = await Promises.tryCatch(Surface.get(element)
                        .requestFloatingTextInput(event, labelField.getValue()))
                    if (status === "rejected") {
                        if (!Errors.isAbort(error)) {return panic(error)}
                    } else {
                        editing.modify(() => labelField.setValue(value))
                    }
                })
            )
        }}/>
    )
    const menu: HTMLElement = (
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
            if (entry === null) {
                MenuItems.forAudioUnitInput(parent, service, host)
            } else {
                MenuItems.forCompositeCell(parent, service, host, entry.compositeDevice())
            }
            parent.addMenuItem(DebugMenus.debugBox(entry === null ? host.audioUnitBoxAdapter().box : entry.box))
        })} style={{minWidth: "0", fontSize: "14px", marginLeft: "auto"}}
                    appearance={{color: Colors.cream, activeColor: Colors.bright}}>
            <Icon symbol={IconSymbol.Menu}/>
        </MenuButton>
    )
    const header: HTMLElement = (<h1 className="header" tabIndex={0}>{name}{menu}</h1>)
    const backButton: HTMLElement = (
        <div className="back-button">
            <Icon symbol={IconSymbol.RoundUp}/>
        </div>
    )
    const controls = entry === null ? (<div/>) : (
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
                          appearance={{activeColor: Colors.orange, framed: true, tooltip: `Mute ${noun}`}}>
                    <Icon symbol={IconSymbol.Mute}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={soloValue}
                          appearance={{activeColor: Colors.yellow, framed: true, tooltip: `Solo ${noun}`}}>
                    <Icon symbol={IconSymbol.Solo}/>
                </Checkbox>
            </div>
        </div>
    )
    // Every sibling branch as a clickable number badge, the edited one highlighted: quick navigation
    // between the composite's chains without going back to the parent.
    const numbers: HTMLElement = <div className="entry-numbers"/>
    const navigation: HTMLElement = (
        <div className="navigation">
            {backButton}
            {numbers}
        </div>
    )
    const element: HTMLElement = (
        <div className={Html.buildClassList(className, entry?.cellKind === "instrument" && "instrument")}>
            {header}{controls}{navigation}
        </div>
    )
    lifecycle.ownAll(
        TextTooltip.default(backButton, () => "Back to the parent chain"),
        Events.subscribe(backButton, "click", () => userEditingManager.audioUnit.edit(backTarget)),
        Events.subscribe(name, "pointerdown", () => {
            deviceSelection.deselectAll()
            header.classList.add("selected")
            header.focus()
        }),
        deviceSelection.catchupAndSubscribe({
            onSelected: () => header.classList.remove("selected"),
            onDeselected: () => {}
        }),
        // The focused header receives the clipboard, exactly like a device header: with the selection
        // cleared by the click above, a paste lands at the start of this branch's chain.
        ClipboardManager.install(header, DevicesClipboard.createHandler({
            getEnabled: () => true,
            editing,
            selection: deviceSelection,
            boxGraph: service.project.boxGraph,
            boxAdapters: service.project.boxAdapters,
            getHost: (): Option<DeviceHost> => Option.wrap(host)
        }))
    )
    if (entry !== null) {
        const rebuildNumbers = () => {
            Html.empty(numbers)
            entry.siblings().forEach(sibling => numbers.appendChild((
                <div className={Html.buildClassList("entry-number", sibling === entry && "current")}
                     onclick={() => {
                         if (sibling !== entry) {userEditingManager.audioUnit.edit(sibling.box)}
                     }}>{String(sibling.indexField.getValue() + 1)}</div>
            )))
        }
        rebuildNumbers()
        lifecycle.ownAll(
            entry.subscribeSiblings(rebuildNumbers),
            labelFieldOf(entry).catchupAndSubscribe(owner => name.textContent = owner.getValue()),
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
