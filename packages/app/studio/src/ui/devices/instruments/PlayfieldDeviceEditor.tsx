import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {DeviceHost, InstrumentFactories, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {SlotGrid} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotGrid"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    deviceHost: DeviceHost
}

const octave = new DefaultObservableValue(5) // TODO Make that bound to its PlayfieldDeviceBoxAdapter

export const PlayfieldDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => {
                          parent.addMenuItem(MenuItem.default({label: "Reset All"})
                              .setTriggerProcedure(() => project.editing.modify(() => adapter.reset())))
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                      }}
                      populateControls={() => (
                          <SlotGrid lifecycle={lifecycle}
                                    service={service}
                                    adapter={adapter}
                                    octave={octave}/>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Playfield.defaultIcon}/>
    )
}