import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumShakerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumShakerDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumShakerDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {color, attack, decay, curve, volume, velocity, play} = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumShaker.defaultIcon}
                              engine="shaker"
                              parameters={Object.values(adapter.namedParameter)}
                              contour={now => ({decay: now(attack) + now(decay), punch: now(curve)})}
                              sections={[
                                  {title: "SHAPE", color: Colors.orange, columns: [[color, attack, decay, curve]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play]]}
                              ]}/>
    )
}
