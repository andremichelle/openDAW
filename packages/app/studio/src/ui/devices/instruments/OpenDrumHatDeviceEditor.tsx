import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumHatDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumHatDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumHatDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {tune, color, hold, decay, spread, ring, reso, curve, volume, velocity, play} = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumHat.defaultIcon}
                              engine="hat"
                              parameters={Object.values(adapter.namedParameter)}
                              sections={[
                                  {title: "SOURCE", color: Colors.orange, columns: [[tune, color]]},
                                  {title: "CHARACTER", color: Colors.purple, columns: [[spread, ring, reso, curve]]},
                                  {title: "SHAPE", color: Colors.green, columns: [[hold, decay]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play]]}
                              ]}/>
    )
}
