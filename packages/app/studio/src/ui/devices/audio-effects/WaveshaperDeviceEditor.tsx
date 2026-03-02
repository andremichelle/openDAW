import css from "./WaveshaperDeviceEditor.sass?inline"
import {DeviceHost, WaveshaperDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Display} from "@/ui/devices/audio-effects/Waveshaper/Display"

const className = Html.adoptStyleSheet(css, "WaveshaperDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WaveshaperDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const WaveshaperDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {inputGain, outputGain, mix} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <Display lifecycle={lifecycle} adapter={adapter}/>
                              {[
                                  ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: inputGain, anchor: 0.0,
                                      style: {gridColumn: "1"}
                                  }),
                                  ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: mix, anchor: 1.0,
                                      style: {gridColumn: "2"}
                                  }),
                                  ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: outputGain, anchor: 0.5,
                                      style: {gridColumn: "3"}
                                  })
                              ]}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Waveshaper.defaultIcon}/>
    )
}