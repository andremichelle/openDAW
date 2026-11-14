import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumRimDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumRimDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumRimDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        tune, ratio, balance, high, highRatio, ring, ringHigh, decay, punch, drive, hard, click, swell, cut, restart,
        volume, velocity, play
    } = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumRim.defaultIcon}
                              engine="rim"
                              parameters={Object.values(adapter.namedParameter)}
                              contour={now => ({decay: now(decay), punch: now(punch)})}
                              sections={[
                                  {title: "TONES", color: Colors.orange, columns: [[tune, ratio, balance, ring]]},
                                  {title: "HIGH", color: Colors.yellow, columns: [[high, highRatio, ringHigh, swell]]},
                                  {title: "SHAPE", color: Colors.green, columns: [[decay, punch, drive, hard]]},
                                  {title: "STRIKE", color: Colors.purple, columns: [[click, cut, restart]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play]]}
                              ]}/>
    )
}
