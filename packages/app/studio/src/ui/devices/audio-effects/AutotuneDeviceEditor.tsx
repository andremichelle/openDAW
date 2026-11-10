import css from "./AutotuneDeviceEditor.sass?inline"
import {AutotuneDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AutotuneTuner} from "@/ui/devices/audio-effects/AutotuneTuner.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {createParameterToggle} from "@/ui/devices/instruments/NanoDeviceEditor/ParameterControls"

const className = Html.adoptStyleSheet(css, "AutotuneDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: AutotuneDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const AutotuneDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {follow, ...knobs} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <AutotuneTuner lifecycle={lifecycle}
                                             receiver={project.liveStreamReceiver}
                                             address={adapter.address.append(0)}/>
                              <div className="follow">
                                  <span>{follow.name}</span>
                                  {createParameterToggle({lifecycle, editing, midiLearning, deviceHost}, follow)}
                              </div>
                              <div className="knobs">
                                  {Object.values(knobs)
                                      .map(parameter => ControlBuilder.createKnob({
                                          lifecycle,
                                          editing,
                                          midiLearning,
                                          adapter,
                                          parameter
                                      }))}
                              </div>
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Autotune.defaultIcon}/>
    )
}
