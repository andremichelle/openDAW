import css from "./AudioSinkDeviceEditor.sass?inline"
import {AudioSinkDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {SnapCommonDecibel} from "@/ui/configs"
import {EffectFactories} from "@opendaw/studio-core"
import {MenuItems} from "../menu-items"
import {StudioService} from "@/service/StudioService"
import {BusOutputSelector} from "@/ui/mixer/BusOutputSelector"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "AudioSinkDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: AudioSinkDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const AudioSinkDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {pass} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning} = project
    const primaryBusUUID = project.primaryAudioBusBox.address.uuid
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <BusOutputSelector lifecycle={lifecycle}
                                                 project={project}
                                                 output={adapter.targetBus}
                                                 pointer={adapter.box.targetBus}
                                                 selectable={bus => {
                                                     const ownBusUUID = deviceHost.audioUnitBoxAdapter().input.adapter().unwrapOrNull()?.uuid ?? UUID.Lowest
                                                     return !UUID.equals(bus.uuid, primaryBusUUID) && UUID.Comparator(bus.uuid, ownBusUUID) !== 0
                                                 }}/>
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: pass,
                                  color: Colors.black,
                                  options: SnapCommonDecibel
                              })}
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Sink.defaultIcon}/>
    )
}
