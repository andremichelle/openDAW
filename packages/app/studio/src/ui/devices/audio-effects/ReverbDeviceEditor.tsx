import css from "./ReverbDeviceEditor.sass?inline"
import {DeviceHost, ReverbDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {SnapCommonDecibel} from "@/ui/configs.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@moises-ai/studio-core"

const className = Html.adoptStyleSheet(css, "ReverbDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ReverbDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const ReverbDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, liveStreamReceiver, midiLearning} = project
    const {decay, preDelay, damp, dry, wet} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter, parameter: decay
                              })}
                              <div/>
                              {ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter, parameter: preDelay
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter, parameter: damp
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: dry,
                                  options: SnapCommonDecibel
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: wet,
                                  options: SnapCommonDecibel
                              })}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Reverb.defaultIcon}/>
    )
}