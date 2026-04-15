import css from "./VocoderDeviceEditor.sass?inline"
import {DeviceHost, VocoderDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {VocoderTransform} from "@/ui/devices/audio-effects/Vocoder/VocoderTransform"
import {ModulatorSourceMenu} from "@/ui/devices/audio-effects/Vocoder/ModulatorSourceMenu"

const className = Html.adoptStyleSheet(css, "VocoderDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: VocoderDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const VocoderDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, rootBoxAdapter} = project
    const {
        carrierMinFreq, carrierMaxFreq, modulatorMinFreq, modulatorMaxFreq,
        qMin, qMax, envAttack, envRelease, emphasis, mix
    } = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="display">
                                  <VocoderTransform lifecycle={lifecycle}
                                                    service={service}
                                                    adapter={adapter}/>
                              </div>
                              <div className="knob-row">
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: carrierMinFreq
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: carrierMaxFreq
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: modulatorMinFreq
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: modulatorMaxFreq
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: qMin
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: qMax
                                  })}
                              </div>
                              <div className="side-panel">
                                  <ModulatorSourceMenu lifecycle={lifecycle}
                                                       editing={editing}
                                                       rootBoxAdapter={rootBoxAdapter}
                                                       adapter={adapter}/>
                                  <div className="bands">
                                      <h1>Bands</h1>
                                      <RadioGroup lifecycle={lifecycle}
                                                  appearance={{framed: true}}
                                                  model={EditWrapper.forValue(editing, adapter.box.bandCount)}
                                                  elements={[
                                                      {value: 8, element: (<span>8</span>)},
                                                      {value: 12, element: (<span>12</span>)},
                                                      {value: 16, element: (<span>16</span>)}
                                                  ]}/>
                                  </div>
                                  <div className="mix-knobs">
                                      {ControlBuilder.createKnob({
                                          lifecycle, editing, midiLearning, adapter, parameter: envAttack
                                      })}
                                      {ControlBuilder.createKnob({
                                          lifecycle, editing, midiLearning, adapter, parameter: envRelease
                                      })}
                                      {ControlBuilder.createKnob({
                                          lifecycle, editing, midiLearning, adapter, parameter: emphasis
                                      })}
                                      {ControlBuilder.createKnob({
                                          lifecycle, editing, midiLearning, adapter, parameter: mix
                                      })}
                                  </div>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Vocoder.defaultIcon}/>
    )
}
