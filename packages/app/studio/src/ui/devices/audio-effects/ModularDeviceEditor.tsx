import css from "./ModularDeviceEditor.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {assert, Lifecycle, SortedSet, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceHost, DeviceInterfaceKnobAdapter, ModularDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@/ui/model/menu-item.ts"
import {BoxVisitor, DeviceInterfaceKnobBox} from "@opendaw/studio-boxes"
import {Box, PointerField} from "@opendaw/lib-box"
import {ContextMenu} from "@/ui/ContextMenu.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ModularDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ModularDeviceBoxAdapter
    deviceHost: DeviceHost
}

type UserInterfaceElement = {
    uuid: UUID.Bytes
    element: Element
    terminable: Terminable
}

export const ModularDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const userInterface: HTMLElement = <div className={className}/>
    const elements: SortedSet<UUID.Bytes, UserInterfaceElement> = UUID.newSet(entry => entry.uuid)
    const addElement = (box: Box): void => {
        const success = box.accept<BoxVisitor<true>>({
            visitDeviceInterfaceKnobBox: (box: DeviceInterfaceKnobBox): true => {
                const runtime = new Terminator()
                const {parameterAdapter} = project.boxAdapters.adapterFor(box, DeviceInterfaceKnobAdapter)
                const element: HTMLElement = ControlBuilder.createKnob({
                    lifecycle: lifecycle,
                    editing: project.editing,
                    midiLearning: project.midiLearning,
                    adapter: adapter,
                    parameter: parameterAdapter,
                    anchor: box.anchor.getValue()
                })
                runtime.own(ContextMenu.subscribe(element, collector =>
                    collector.addItems(MenuItem.default({label: "Remove"})
                        .setTriggerProcedure(() => project.editing.modify(() => box.delete())))))
                userInterface.appendChild(element)
                runtime.own({terminate: () => element.remove()})
                elements.add({
                    uuid: box.address.uuid,
                    element,
                    terminable: runtime
                })
                return true
            }
        })
        assert(success === true, `Could not resolve ${box}`)
    }
    const removeElement = (box: Box): void => {
        const sucess = box.accept<BoxVisitor<true>>({
            visitDeviceInterfaceKnobBox: (box: DeviceInterfaceKnobBox): true => {
                elements.removeByKey(box.address.uuid).terminable.terminate()
                return true
            }
        })
        assert(sucess === true, `Could not resolve ${box}`)
    }
    adapter.box.userInterface.elements.pointerHub.incoming().forEach(pointer => addElement(pointer.box))
    lifecycle.own(adapter.box.userInterface.elements.pointerHub.subscribe({
        onAdded: (pointer: PointerField) => addElement(pointer.box),
        onRemoved: (pointer: PointerField) => removeElement(pointer.box)
    }))
    lifecycle.own({terminate: () => elements.forEach(entry => entry.terminable.terminate())})
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => userInterface}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Modular.defaultIcon}>
        </DeviceEditor>
    )
}