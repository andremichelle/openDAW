import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumBellDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumBellDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumBellDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {tune, ratio, balance, color, strike, decay, volume, velocity, play} = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumBell.defaultIcon}
                              engine="bell"
                              parameters={Object.values(adapter.namedParameter)}
                              sections={[
                                  {title: "TONES", color: Colors.orange, columns: [[tune, ratio, balance]]},
                                  {title: "SHAPE", color: Colors.green, columns: [[color, strike, decay]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play]]}
                              ]}/>
    )
}
