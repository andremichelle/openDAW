import css from "./GuitarAmpDeviceEditor.sass?inline"
import {DeviceHost, GuitarAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "GuitarAmpDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: GuitarAmpDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const GuitarAmpDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {mix, output} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="latency-mode">
                                  <h1>Latency</h1>
                                  <RadioGroup lifecycle={lifecycle}
                                              appearance={{framed: true}}
                                              model={EditWrapper.forValue(editing, adapter.box.lowLatency)}
                                              elements={[
                                                  {value: true, element: (<span>Zero</span>)},
                                                  {value: false, element: (<span>Low</span>)}
                                              ]}/>
                              </div>
                              {ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter, parameter: mix
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter, parameter: output, anchor: 0.5
                              })}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.GuitarAmp.defaultIcon}/>
    )
}
