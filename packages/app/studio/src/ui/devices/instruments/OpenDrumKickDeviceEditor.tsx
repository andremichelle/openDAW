import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumKickDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumKickDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumKickDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        tune, pitch, sweep, drift, decay, punch, shape, skin, click, tone, noise, drive,
        rumble, length, duck, bright, volume, velocity, play, glide
    } = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumKick.defaultIcon}
                              engine="kick"
                              parameters={Object.values(adapter.namedParameter)}
                              contour={now => ({pitch: now(pitch), sweep: now(sweep), drift: now(drift)})}
                              sections={[
                                  {title: "BODY", color: Colors.orange, columns: [[tune, pitch, sweep, drift],
                                          [decay, punch, shape, skin]]},
                                  {title: "STRIKE", color: Colors.yellow, columns: [[click, tone, noise, drive]]},
                                  {title: "RUMBLE", color: Colors.purple, columns: [[rumble, length, duck, bright]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play, glide]]}
                              ]}/>
    )
}
