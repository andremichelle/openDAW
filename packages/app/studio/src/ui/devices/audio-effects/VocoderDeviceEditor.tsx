import css from "./VocoderDeviceEditor.sass?inline"
import {DeviceHost, VocoderDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {DefaultObservableValue, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {AudioAnalyser} from "@opendaw/lib-dsp"
import {EffectFactories} from "@opendaw/studio-core"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {DisplayMode, VocoderTransform} from "@/ui/devices/audio-effects/Vocoder/VocoderTransform"
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
        qMin, qMax, envAttack, envRelease, gain, mix
    } = adapter.namedParameter
    const displayMode = lifecycle.own(new DefaultObservableValue(DisplayMode.Transform))
    const spectrum = new Float32Array(AudioAnalyser.DEFAULT_SIZE)
    const spectrumSubscription = lifecycle.own(new Terminator())
    const updateSpectrumSubscription = () => {
        spectrumSubscription.terminate()
        spectrum.fill(0)
        const mode = displayMode.getValue()
        if (mode === DisplayMode.Modulator) {
            spectrumSubscription.own(project.liveStreamReceiver.subscribeFloats(
                adapter.modulatorSpectrum, values => spectrum.set(values)))
        } else if (mode === DisplayMode.Carrier) {
            spectrumSubscription.own(project.liveStreamReceiver.subscribeFloats(
                adapter.carrierSpectrum, values => spectrum.set(values)))
        }
    }
    lifecycle.own(displayMode.catchupAndSubscribe(updateSpectrumSubscription))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="display" style={{gridArea: "1 / 1 / 3 / 7"}}>
                                  <VocoderTransform lifecycle={lifecycle}
                                                    service={service}
                                                    adapter={adapter}
                                                    displayMode={displayMode}
                                                    spectrum={spectrum}/>
                              </div>
                              <div className="controls" style={{gridArea: "1 / 8 / 2 / 10"}}>
                                  <ModulatorSourceMenu lifecycle={lifecycle}
                                                       editing={editing}
                                                       rootBoxAdapter={rootBoxAdapter}
                                                       adapter={adapter}/>
                                  <div className="selector">
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
                                  <div className="selector">
                                      <h1>Display</h1>
                                      <RadioGroup lifecycle={lifecycle}
                                                  appearance={{framed: true}}
                                                  model={displayMode}
                                                  elements={[
                                                      {value: DisplayMode.Transform, element: (<span>T</span>), tooltip: "Transform"},
                                                      {value: DisplayMode.Modulator, element: (<span>M</span>), tooltip: "Modulator Spectrum"},
                                                      {value: DisplayMode.Carrier, element: (<span>C</span>), tooltip: "Carrier Spectrum"}
                                                  ]}/>
                                  </div>
                              </div>
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: carrierMinFreq, style: {gridArea: "3 / 1"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: carrierMaxFreq, style: {gridArea: "3 / 2"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: modulatorMinFreq, style: {gridArea: "3 / 3"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: modulatorMaxFreq, style: {gridArea: "3 / 4"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: qMin, style: {gridArea: "3 / 5"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: qMax, style: {gridArea: "3 / 6"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: envAttack, style: {gridArea: "2 / 8"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: envRelease, style: {gridArea: "2 / 9"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: gain, style: {gridArea: "3 / 8"}})}
                              {ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter: mix, style: {gridArea: "3 / 9"}})}
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
