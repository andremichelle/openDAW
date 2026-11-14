import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumTomDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumTomDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumTomDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        tune, pitch, sweep, drift, decay, punch, shape, sub, ratio, top, length, drive, noise, noiseDecay, color,
        air, volume, velocity, play, glide
    } = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumTom.defaultIcon}
                              engine="tom"
                              parameters={Object.values(adapter.namedParameter)}
                              contour={now => ({
                                  pitch: now(pitch), sweep: now(sweep), drift: now(drift), decay: now(decay),
                                  punch: now(punch)
                              })}
                              sections={[
                                  {title: "BODY", color: Colors.orange, columns: [[tune, pitch, sweep, drift],
                                          [decay, punch, shape, drive]]},
                                  {title: "LAYERS", color: Colors.yellow, columns: [[sub, ratio, top, length]]},
                                  {title: "NOISE", color: Colors.green, columns: [[noise, noiseDecay, color, air]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play, glide]]}
                              ]}/>
    )
}
