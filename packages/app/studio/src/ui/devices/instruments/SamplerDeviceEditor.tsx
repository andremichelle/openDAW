import css from "./SamplerDeviceEditor.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceHost, InstrumentFactories, SamplerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Button} from "@/ui/components/Button"
import {StudioService} from "@/service/StudioService"
import {ControlContext} from "./NanoDeviceEditor/ParameterControls"
import {SamplerVoiceStacks} from "./SamplerDeviceEditor/SamplerVoiceStacks"
import {SamplerModulationList} from "./SamplerDeviceEditor/SamplerModulationList"
import {SamplerSamples} from "./SamplerDeviceEditor/SamplerSamples"
import {SamplerZoneWindow} from "./SamplerDeviceEditor/SamplerZoneWindow"

const className = Html.adoptStyleSheet(css, "SamplerDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: SamplerDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const SamplerDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver} = project
    const context: ControlContext = {lifecycle, editing, midiLearning, deviceHost}
    const {stacks, highlight} = SamplerVoiceStacks.create(context, adapter, project.timelineBox.bpm)
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateHeader={() => (
                          // 12px makes the button 18px high: at the header's 11px it is 16.5px and sits half a pixel off the icons
                          <Button lifecycle={lifecycle} appearance={{color: Colors.green, activeColor: Colors.bright, cursor: "pointer"}}
                                  style={{fontSize: "12px", position: "relative", top: "1px"}}
                                  onClick={() => SamplerZoneWindow.open(service, adapter, deviceHost)}>
                              <span style={{fontSize: "11px"}}>Edit Sample Zones</span>
                          </Button>
                      )}
                      populateControls={() => (
                          <div className={className} onInit={element => lifecycle.own(
                              SamplerSamples.installDrop(element, element, service,
                                  () => samples => SamplerSamples.add(project, adapter, undefined, samples)))}>
                              <div className="stacks">{stacks.slice(0, 3)}</div>
                              <div className="stacks">{stacks.slice(3)}</div>
                              <SamplerModulationList lifecycle={lifecycle} editing={editing} adapter={adapter} onHover={highlight}/>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Sampler.defaultIcon}/>
    )
}
