import css from "./DeviceEditor.sass?inline"
import {Editing, Errors, Lifecycle, ObservableValue, panic, Procedure, Provider} from "@opendaw/lib-std"
import {createElement, Group, JsxValue} from "@opendaw/lib-jsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {MenuItem, Project} from "@opendaw/studio-core"
import {DeviceBoxAdapter, DeviceType, EffectDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {DebugMenus} from "@/ui/menu/debug.ts"
import {DragDevice} from "@/ui/AnyDragData"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {Events, Html} from "@opendaw/lib-dom"
import {TextScroller} from "@/ui/TextScroller"
import {StringField} from "@opendaw/lib-box"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Promises} from "@opendaw/lib-runtime"
import {Surface} from "@/ui/surface/Surface"

const className = Html.adoptStyleSheet(css, "DeviceEditor")

const getColorFor = (type: DeviceType) => {
    switch (type) {
        case "midi-effect":
            return Colors.orange
        case "bus":
        case "instrument":
            return Colors.green
        case "audio-effect":
            return Colors.blue
    }
}

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: DeviceBoxAdapter
    populateMenu: Procedure<MenuItem>
    populateControls: Provider<JsxValue>
    populateMeter: Provider<JsxValue>
    createLabel?: Provider<HTMLElement>
    icon: IconSymbol
    className?: string
}

const defaultLabelFactory = (lifecycle: Lifecycle, editing: Editing, labelField: StringField): Provider<JsxValue> =>
    () => (
        <h1 onInit={element => {
            lifecycle.ownAll(
                TextScroller.install(element),
                labelField.catchupAndSubscribe(owner => element.textContent = owner.getValue()),
                Events.subscribeDblDwn(element, async event => {
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

export const DeviceEditor =
    ({
         lifecycle, project, adapter, populateMenu, populateControls, populateMeter,
         createLabel, icon, className: customClassName
     }: Construct) => {
        const {editing} = project
        const {box, type, enabledField, minimizedField, labelField} = adapter
        const color = getColorFor(type)
        return (
            <div className={Html.buildClassList(className, customClassName)}
                 tabIndex={0}
                 onInit={element => {
                     const updateSelected = () =>
                         element.classList.toggle("selected", project.deviceSelection.isSelected(adapter))
                     lifecycle.ownAll(
                         enabledField.catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                             element.classList.toggle("enabled", owner.getValue())),
                         minimizedField.catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                             element.classList.toggle("minimized", owner.getValue())),
                         project.deviceSelection.catchupAndSubscribe({
                             onSelected: updateSelected,
                             onDeselected: updateSelected
                         })
                     )
                 }} data-drag>
                <header onpointerdown={event => {
                    const {deviceSelection} = project
                    if (event.shiftKey) {
                        if (deviceSelection.isSelected(adapter)) {
                            deviceSelection.deselect(adapter)
                        } else {
                            deviceSelection.select(adapter)
                        }
                    } else {
                        deviceSelection.deselectAll()
                        deviceSelection.select(adapter)
                    }
                }} onInit={element => {
                    if (type === "midi-effect" || type === "audio-effect") {
                        const effect = adapter as EffectDeviceBoxAdapter
                        lifecycle.own(DragAndDrop.installSource(element, () => ({
                            type: effect.type,
                            start_index: effect.indexField.getValue()
                        } satisfies DragDevice), element))
                    }
                }} style={{color: color.toString()}}>
                    <Icon symbol={icon} onInit={element =>
                        lifecycle.ownAll(
                            Events.subscribe(element, "pointerdown", event => event.stopPropagation()),
                            Events.subscribe(element, "click", () => editing.modify(() => minimizedField.toggle()))
                        )}/>
                    <Icon symbol={IconSymbol.Shutdown} onInit={element =>
                        lifecycle.ownAll(
                            Events.subscribe(element, "pointerdown", event => event.stopPropagation()),
                            Events.subscribe(element, "click", () => editing.modify(() => enabledField.toggle()))
                        )}/>
                    {(createLabel ?? defaultLabelFactory(lifecycle, editing, labelField))()}
                </header>
                <MenuButton root={MenuItem.root()
                    .setRuntimeChildrenProcedure(parent => {
                        populateMenu(parent)
                        parent.addMenuItem(DebugMenus.debugBox(box))
                    })} style={{minWidth: "0", fontSize: "0.75em"}} appearance={{color, activeColor: Colors.bright}}>
                    <Icon symbol={IconSymbol.Menu}/>
                </MenuButton>
                <Group>{minimizedField.getValue() ? null : populateControls()}</Group>
                <Group>{populateMeter()}</Group>
                <div/>
            </div>
        )
    }