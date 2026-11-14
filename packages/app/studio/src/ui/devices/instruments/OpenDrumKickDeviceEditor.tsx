import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {
    AutomatableParameterFieldAdapter, DeviceHost, InstrumentFactories, OpenDrumKickDeviceBoxAdapter
} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {OpenDrumDeviceEditor} from "@/ui/devices/instruments/OpenDrumDeviceEditor"
import {OpenDrumSynth} from "@/ui/devices/instruments/OpenDrum/OpenDrumSynth"

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
    const {bpm} = service.project.timelineBox
    // the display shows the values as they sound, automation and modulation included
    const now = (parameter: AutomatableParameterFieldAdapter<number>): number => parameter.getControlledValue()
    const request = (): OpenDrumSynth.Request => OpenDrumSynth.kick({
        tune: now(tune), pitch: now(pitch), sweep: now(sweep), drift: now(drift), decay: now(decay),
        punch: now(punch), shape: now(shape), click: now(click), tone: now(tone), skin: now(skin),
        rumble: now(rumble), length: now(length), duck: now(duck), drive: now(drive), velocity: now(velocity),
        play: now(play), bright: now(bright), volume: now(volume), noise: now(noise), glide: now(glide)
    }, bpm.getValue())
    return (
        <OpenDrumDeviceEditor lifecycle={lifecycle}
                              service={service}
                              adapter={adapter}
                              deviceHost={deviceHost}
                              color={Colors.orange}
                              icon={InstrumentFactories.OpenDrumKick.defaultIcon}
                              request={request}
                              sections={[
                                  {title: "BODY", color: Colors.orange, columns: [[tune, pitch, sweep, drift],
                                          [decay, punch, shape, skin]]},
                                  {title: "STRIKE", color: Colors.yellow, columns: [[click, tone, noise, drive]]},
                                  {title: "RUMBLE", color: Colors.purple, columns: [[rumble, length, duck, bright]]},
                                  {title: "PLAY", color: Colors.cream, columns: [[volume, velocity, play, glide]]}
                              ]}/>
    )
}
