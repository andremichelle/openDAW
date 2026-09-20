import css from "./DeviceEditor.sass?inline"
import {
    Editing,
    Errors,
    isNotNull,
    Lifecycle,
    ObservableValue,
    Option,
    panic,
    Procedure,
    Provider
} from "@opendaw/lib-std"
import {createElement, Group, JsxValue} from "@opendaw/lib-jsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {ClipboardManager, DevicesClipboard, MenuItem} from "@opendaw/studio-core"
import {DeviceBoxAdapter, DeviceHost, Devices, DeviceType, InstrumentFactories} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {DebugMenus} from "@/ui/menu/debug.ts"
import {DeviceDragging} from "@/ui/devices/DeviceDragging"
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
    service: StudioService
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
         lifecycle, service, adapter, populateMenu, populateControls, populateMeter,
         createLabel, icon, className: customClassName
     }: Construct) => {
        const {project} = service
        const {editing} = project
        const {box, type, enabledField, minimizedField, labelField} = adapter
        const color = getColorFor(type)
        const deviceKey = InstrumentFactories.keyOfBox(box) ?? box.name.replace(/DeviceBox$/, "")
        const presetCategory = type === "instrument" || type === "audio-effect" || type === "midi-effect"
            ? type
            : null
        return (
            <div className={Html.buildClassList(className, customClassName)}
                 onInit={element => {
                     lifecycle.ownAll(
                         enabledField.catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                             element.classList.toggle("enabled", owner.getValue())),
                         minimizedField.catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                             element.classList.toggle("minimized", owner.getValue()))
                     )
                 }} data-drag>
                <header tabIndex={0} onInit={element => {
                    const updateSelected = () =>
                        element.classList.toggle("selected", project.deviceSelection.isSelected(adapter))
                    let pendingCollapseSelection = false
                    let dragStartedOnHeader = false
                    const onPointerDown = (event: PointerEvent) => {
                        const {deviceSelection} = project
                        dragStartedOnHeader = false
                        if (event.shiftKey || event.metaKey || event.ctrlKey) {
                            if (deviceSelection.isSelected(adapter)) {
                                deviceSelection.deselect(adapter)
                            } else {
                                deviceSelection.select(adapter)
                            }
                            pendingCollapseSelection = false
                        } else if (deviceSelection.isSelected(adapter)) {
                            pendingCollapseSelection = true
                        } else {
                            deviceSelection.deselectAll()
                            deviceSelection.select(adapter)
                            pendingCollapseSelection = false
                        }
                    }
                    const onPointerUp = () => {
                        if (pendingCollapseSelection && !dragStartedOnHeader) {
                            project.deviceSelection.deselectAll()
                            project.deviceSelection.select(adapter)
                        }
                        pendingCollapseSelection = false
                        dragStartedOnHeader = false
                    }
                    lifecycle.ownAll(
                        project.deviceSelection.catchupAndSubscribe({
                            onSelected: updateSelected,
                            onDeselected: updateSelected
                        }),
                        Events.subscribe(element, "pointerdown", onPointerDown),
                        Events.subscribe(element, "pointerup", onPointerUp),
                        ClipboardManager.install(element, DevicesClipboard.createHandler({
                            getEnabled: () => true,
                            editing: project.editing,
                            selection: project.deviceSelection,
                            boxGraph: project.boxGraph,
                            boxAdapters: project.boxAdapters,
                            getHost: (): Option<DeviceHost> => {
                                if (Devices.isHost(adapter)) {return Option.wrap(adapter)}
                                return Option.wrap(adapter.deviceHost())
                            }
                        }))
                    )
                    lifecycle.own(DeviceDragging.install(project, element, adapter, color,
                        () => {dragStartedOnHeader = true}))
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
                    {isNotNull(presetCategory) && (() => {
                        const category = presetCategory
                        // Folder-icon dropdown showing every preset for this
                        // device: user presets first (folder icon), then
                        // stock presets (cloud icon), already sorted in this
                        // order by `presetsFor`. A separator is inserted at
                        // the first stock entry that follows any user entry.
                        // The button is disabled when no presets exist.
                        const availability = service.presets.observePresetAvailability(
                            category, deviceKey, lifecycle)
                        const button: HTMLButtonElement = (
                            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
                                let prevSource: "" | "user" | "stock" = ""
                                const presets = service.presets.presetsFor(category, deviceKey)
                                if (presets.length === 0) {
                                    parent.addMenuItem(MenuItem.default({
                                        label: "No presets available",
                                        selectable: false
                                    }))
                                } else {
                                    parent.addMenuItem(MenuItem.header({
                                        label: "Presets",
                                        icon: IconSymbol.Folder,
                                        color
                                    }))
                                    presets.forEach(entry => {
                                        const separatorBefore = prevSource === "user" && entry.source === "stock"
                                        prevSource = entry.source
                                        parent.addMenuItem(MenuItem.default({
                                            label: entry.name,
                                            icon: entry.source === "user"
                                                ? IconSymbol.UserFolder
                                                : IconSymbol.CloudFolder,
                                            separatorBefore
                                        }).setTriggerProcedure(() =>
                                            service.presets.applyPresetTo(adapter, entry).catch(console.warn)))
                                    })
                                }
                            })}
                                        appearance={{tooltip: "Load preset"}}
                                        style={{fontSize: "14px", color: "currentColor"}}>
                                <Icon symbol={IconSymbol.Folder}/>
                            </MenuButton>
                        )
                        const apply = () => {button.disabled = !availability.getValue()}
                        apply()
                        lifecycle.own(availability.subscribe(apply))
                        return button
                    })()}
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