import css from "./NanoDeviceEditor.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceHost, InstrumentFactories, NanoDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {SampleDropZone} from "@/ui/devices/SampleDropZone"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "NanoDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NanoDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const NanoDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {volume, release} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning} = project
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning: midiLearning,
                                  adapter,
                                  parameter: volume
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning: midiLearning,
                                  adapter,
                                  parameter: release
                              })}
                              <SampleDropZone lifecycle={lifecycle} service={service} file={adapter.box.file}/>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Nano.defaultIcon}/>
    )
}