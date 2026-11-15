import css from "./MixerDeviceCell.sass?inline"
import {Lifecycle, ObservableValue, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Browser, Events, Html} from "@opendaw/lib-dom"
import {AudioUnitBoxAdapter, EffectDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {getColorFor} from "@/ui/devices/DeviceEditor"
import {DeviceDragging} from "@/ui/devices/DeviceDragging"
import {MenuItems} from "@/ui/devices/menu-items"
import {DebugMenus} from "@/ui/menu/debug"
import {TextScroller} from "@/ui/TextScroller"
import {DeviceNavigation} from "@/ui/mixer/DeviceNavigation"

const className = Html.adoptStyleSheet(css, "MixerDeviceCell")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    unit: AudioUnitBoxAdapter
    adapter: EffectDeviceBoxAdapter
    frozen: ObservableValue<boolean>
}

export const MixerDeviceCell = ({lifecycle, service, unit, adapter, frozen}: Construct) => {
    const {project} = service
    const {editing, deviceSelection} = project
    const {enabledField, labelField, type} = adapter
    const color = getColorFor(type)
    const led: HTMLElement = <div className="led"/>
    const label: HTMLElement = <span className="label"/>
    const element: HTMLElement = (
        <div className={className} data-drag style={{color: color.toString()}}>
            {led}{label}
        </div>
    )
    const updateSelected = () => element.classList.toggle("selected", deviceSelection.isSelected(adapter))
    const dragLifecycle = lifecycle.own(new Terminator())
    let pendingNavigate = false
    let dragged = false
    lifecycle.ownAll(
        enabledField.catchupAndSubscribe(owner => element.classList.toggle("enabled", owner.getValue())),
        labelField.catchupAndSubscribe(owner => label.textContent = owner.getValue()),
        frozen.catchupAndSubscribe(owner => {
            const isFrozen = owner.getValue()
            element.classList.toggle("frozen", isFrozen)
            dragLifecycle.terminate()
            element.draggable = false
            if (!isFrozen) {dragLifecycle.own(DeviceDragging.install(project, element, adapter, color, () => dragged = true))}
        }),
        deviceSelection.catchupAndSubscribe({onSelected: updateSelected, onDeselected: updateSelected}),
        TextScroller.install(label),
        Events.subscribe(led, "pointerdown", event => event.stopPropagation()),
        Events.subscribe(led, "click", () => {
            if (frozen.getValue()) {return}
            editing.modify(() => enabledField.toggle())
        }),
        Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
            dragged = false
            pendingNavigate = false
            if (event.button !== 0 || (Browser.isMacOS() && event.ctrlKey)) {return}
            if (event.shiftKey || event.metaKey || event.ctrlKey) {
                const host = adapter.deviceHost()
                deviceSelection.selected()
                    .filter(selected => selected.deviceHost() !== host)
                    .forEach(selected => deviceSelection.deselect(selected))
                if (deviceSelection.isSelected(adapter)) {
                    deviceSelection.deselect(adapter)
                } else {
                    deviceSelection.select(adapter)
                }
                return
            }
            if (!deviceSelection.isSelected(adapter)) {
                deviceSelection.deselectAll()
                deviceSelection.select(adapter)
            }
            pendingNavigate = true
        }),
        Events.subscribe(element, "pointerup", (event: PointerEvent) => {
            if (pendingNavigate && !dragged && event.button === 0) {DeviceNavigation.reveal(service, unit, adapter)}
            pendingNavigate = false
        }),
        Events.subscribe(element, "dragend", () => pendingNavigate = false),
        ContextMenu.subscribe(element, collector => {
            collector.stopPropagation()
            if (frozen.getValue()) {return}
            if (!deviceSelection.isSelected(adapter)) {
                deviceSelection.deselectAll()
                deviceSelection.select(adapter)
            }
            const root = MenuItem.root()
            MenuItems.forEffectDevice(root, service, adapter.deviceHost(), adapter)
            root.addMenuItem(DebugMenus.debugBox(adapter.box))
            collector.addItems(...root.collectChildren())
        })
    )
    return element
}
