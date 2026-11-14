import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumPercDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumPercDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumPercDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        tune, ratio, index, bite, pitch, sweep, decay, curve, noise, drive, volume, velocity, play
    } = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumPerc.defaultIcon}
                              engine="perc"
                              parameters={Object.values(adapter.namedParameter)}
                              contour={now => ({
                                  pitch: now(pitch), sweep: now(sweep), decay: now(decay), punch: now(curve)
                              })}
                              sections={[
                                  {title: "FM", color: Colors.orange, columns: [[tune, ratio, index, bite]]},
                                  {title: "SHAPE", color: Colors.green, columns: [[pitch, sweep, decay, curve]]},
                                  {title: "GRIT", color: Colors.purple, columns: [[noise, drive]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play]]}
                              ]}/>
    )
}
