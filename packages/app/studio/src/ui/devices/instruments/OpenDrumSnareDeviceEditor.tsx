import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumSnareDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumSnareDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumSnareDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        tune, ratio, balance, pitch, sweep, decay, punch, shape, level, wireDecay, width, curve, click, tone, skin,
        drive, volume, velocity, play, glide
    } = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumSnare.defaultIcon}
                              engine="snare"
                              parameters={Object.values(adapter.namedParameter)}
                              contour={now => ({pitch: now(pitch), sweep: now(sweep)})}
                              sections={[
                                  {title: "BODY", color: Colors.orange, columns: [[tune, ratio, balance, pitch],
                                          [sweep, decay, punch, shape]]},
                                  {title: "STRIKE", color: Colors.yellow, columns: [[click, tone, skin, drive]]},
                                  {title: "NOISE", color: Colors.green, columns: [[level, wireDecay, width, curve]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play, glide]]}
                              ]}/>
    )
}
