import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceHost, InstrumentFactories, OpenDrumClapDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: OpenDrumClapDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const OpenDrumClapDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        hands, gap, last, spread, attack, decay, snap, drive, tone, resonance, room, roomDecay, tail, volume,
        velocity, play
    } = adapter.namedParameter
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              icon={InstrumentFactories.OpenDrumClap.defaultIcon}
                              engine="clap"
                              parameters={Object.values(adapter.namedParameter)}
                              sections={[
                                  {title: "HANDS", color: Colors.orange, columns: [[hands, gap, last, spread]]},
                                  {title: "BURST", color: Colors.yellow, columns: [[attack, decay, snap, drive]]},
                                  {title: "TONE", color: Colors.purple, columns: [[tone, resonance]]},
                                  {title: "ROOM", color: Colors.green, columns: [[room, roomDecay, tail]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play]]}
                              ]}/>
    )
}
