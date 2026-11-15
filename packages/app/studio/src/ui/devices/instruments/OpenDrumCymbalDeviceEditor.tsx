import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumCymbalDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumCymbalDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumCymbalDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {tune, tone, attack, decay, volume, velocity, play, panning} = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumCymbal.defaultIcon}
                              engine="cymbal"
                              parameters={Object.values(adapter.namedParameter)}
                              sections={[
                                  {title: "SHAPE", color: Colors.orange, columns: [[tune, tone, attack, decay]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, panning, velocity, play]]}
                              ]}/>
    )
}
