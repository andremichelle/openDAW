import css from "./VaporisateurDeviceEditor.sass?inline"
import {
    DefaultObservableValue,
    Func,
    identity,
    int,
    isDefined,
    Lifecycle,
    ObservableValue,
    TAU,
    Terminator,
    Unhandled
} from "@moises-ai/lib-std"
import {createElement, Frag, replaceChildren} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {
    AutomatableParameterFieldAdapter,
    DeviceHost,
    InstrumentFactories,
    VaporisateurDeviceBoxAdapter
} from "@moises-ai/studio-adapters"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@moises-ai/studio-enums"
import {ClassicWaveform} from "@moises-ai/lib-dsp"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {WaveformDisplay} from "@/ui/devices/instruments/VaporisateurDeviceEditor/WaveformDisplay"
import {EnvelopeDisplay} from "@/ui/devices/instruments/VaporisateurDeviceEditor/EnvelopeDisplay"
import {FilterDisplay} from "@/ui/devices/instruments/VaporisateurDeviceEditor/FilterDisplay"
import {Logo} from "@/ui/devices/instruments/VaporisateurDeviceEditor/Logo"
import {OscillatorSelector} from "@/ui/devices/instruments/VaporisateurDeviceEditor/OscillatorSelector"
import {AutomatableControl} from "@/ui/components/AutomatableControl"

const className = Html.adoptStyleSheet(css, "editor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: VaporisateurDeviceBoxAdapter
    deviceHost: DeviceHost
}

const smoothNoise = (x: number, frequency: number): number => {
    const p = x * frequency
    const i0 = Math.floor(p)
    const i1 = i0 + 1
    const t = p - i0
    const fade = t * t * (3.0 - 2.0 * t)
    const hash = (n: number): number => {
        const v = Math.sin(n * 127.1) * 43758.5453123
        return (v - Math.floor(v)) * 2.0 - 1.0
    }
    const n0 = hash(i0)
    const n1 = hash(i1)
    return n0 + (n1 - n0) * fade
}

export const VaporisateurDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver} = project
    const {
        oscillators,
        noise,
        unisonCount,
        unisonDetune,
        unisonStereo,
        glideTime,
        cutoff,
        resonance,
        filterEnvelope,
        filterKeyboard,
        filterOrder,
        lfoWaveform,
        lfoRate,
        lfoTargetTune,
        lfoTargetCutoff,
        lfoTargetVolume,
        attack,
        decay,
        sustain,
        release,
        voicingMode
    } = adapter.namedParameter
    const createLabelControlFrag = (lifecycle: Lifecycle,
                                    parameter: AutomatableParameterFieldAdapter<number>,
                                    threshold?: number | ReadonlyArray<number>) => (
        <Frag>
            <h3>{parameter.name}</h3>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}
                                       options={isDefined(threshold) ? {snap: {threshold}} : undefined}
                                       supressValueFlyout={true}>
                <ParameterLabel lifecycle={lifecycle}
                                editing={editing}
                                midiLearning={midiLearning}
                                adapter={adapter}
                                parameter={parameter}
                                classList={["center"]}
                                framed={true} standalone/>
            </RelativeUnitValueDragging>
        </Frag>
    )
    const createWaveformSelector = (lifecycle: Lifecycle,
                                    parameter: AutomatableParameterFieldAdapter<ClassicWaveform>) => (
        <Frag>
            <h3>{parameter.name}</h3>
            <AutomatableControl lifecycle={lifecycle}
                                editing={editing}
                                midiLearning={midiLearning}
                                adapter={adapter}
                                parameter={parameter}>
                <RadioGroup lifecycle={lifecycle}
                            model={EditWrapper.forAutomatableParameter(editing, parameter)}
                            style={{fontSize: "9px"}}
                            elements={[
                                {
                                    value: ClassicWaveform.sine,
                                    element: <Icon symbol={IconSymbol.Sine}/>
                                },
                                {
                                    value: ClassicWaveform.triangle,
                                    element: <Icon symbol={IconSymbol.Triangle}/>
                                },
                                {
                                    value: ClassicWaveform.saw,
                                    element: <Icon symbol={IconSymbol.Sawtooth}/>
                                },
                                {
                                    value: ClassicWaveform.square,
                                    element: <Icon symbol={IconSymbol.Square
                                    }/>
                                }
                            ]}/>
            </AutomatableControl>
        </Frag>
    )
    const bindWaveformParameter = (lifecycle: Lifecycle,
                                   parameter: AutomatableParameterFieldAdapter<ClassicWaveform>) => {
        const func = new DefaultObservableValue<Func<number, number>>(identity)
        lifecycle.own(parameter.catchupAndSubscribe(owner => {
            const waveform = owner.getControlledValue()
            switch (waveform) {
                case ClassicWaveform.sine:
                    return func.setValue((x: number) => Math.sin(x * TAU))
                case ClassicWaveform.triangle:
                    return func.setValue((x: number) => 1.0 - 4.0 * Math.abs(x - 0.5))
                case ClassicWaveform.saw:
                    return func.setValue((x: number) => 2.0 * x - 1.0)
                case ClassicWaveform.square:
                    return func.setValue((x: number) => x < 0.5 ? 1.0 : -1.0)
                default:
                    return Unhandled(waveform)
            }
        }))
        return func
    }
    const oscIndex = lifecycle.own(new DefaultObservableValue<int>(0))
    const noiseTable = ObservableValue.seal<Func<number, number>>(x => smoothNoise(x, 32))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="label unisono-section"/>
                              <div style={{display: "contents"}}>
                                  <Logo/>
                                  <div/>
                                  <div>
                                      <h3>Play-Mode</h3>
                                      <RadioGroup lifecycle={lifecycle}
                                                  model={EditWrapper.forAutomatableParameter(editing, voicingMode)}
                                                  style={{fontSize: "9px"}}
                                                  elements={[
                                                      {
                                                          value: 0,
                                                          element: <span>MONO</span>
                                                      },
                                                      {
                                                          value: 1,
                                                          element: <span>POLY</span>
                                                      }
                                                  ]}/>
                                  </div>
                                  <div>{createLabelControlFrag(lifecycle, glideTime)}</div>
                                  <div className="unisono-section">
                                      {createLabelControlFrag(lifecycle, unisonCount)}
                                  </div>
                                  <div className="unisono-section">
                                      {createLabelControlFrag(lifecycle, unisonDetune, 0.5)}
                                  </div>
                                  <div className="unisono-section">
                                      {createLabelControlFrag(lifecycle, unisonStereo)}
                                  </div>
                              </div>
                              <div style={{display: "contents"}} onInit={element => {
                                  const oscLifecycle = lifecycle.own(new Terminator())
                                  lifecycle.own(oscIndex.catchupAndSubscribe(owner => {
                                      oscLifecycle.terminate()
                                      const sourceIndex = owner.getValue()
                                      replaceChildren(element, sourceIndex === 2 ? (
                                          <Frag>
                                              <header>
                                                  <WaveformDisplay lifecycle={oscLifecycle}
                                                                   adapter={noiseTable}/>
                                              </header>
                                              <OscillatorSelector lifecycle={oscLifecycle} oscIndex={oscIndex}/>
                                              <div>
                                                  {createLabelControlFrag(oscLifecycle, noise.attack)}
                                              </div>
                                              <div>
                                                  {createLabelControlFrag(oscLifecycle, noise.hold)}
                                              </div>
                                              <div>
                                                  {createLabelControlFrag(oscLifecycle, noise.release)}
                                              </div>
                                              <div>
                                                  {createLabelControlFrag(oscLifecycle, noise.volume)}
                                              </div>
                                          </Frag>
                                      ) : (
                                          <Frag>
                                              <header>
                                                  <WaveformDisplay lifecycle={oscLifecycle}
                                                                   adapter={bindWaveformParameter(oscLifecycle,
                                                                       oscillators[sourceIndex].waveform)}/>
                                              </header>
                                              <OscillatorSelector lifecycle={oscLifecycle} oscIndex={oscIndex}/>
                                              <div>
                                                  {createWaveformSelector(oscLifecycle,
                                                      oscillators[sourceIndex].waveform)}
                                              </div>
                                              <div>
                                                  {createLabelControlFrag(oscLifecycle,
                                                      oscillators[sourceIndex].octave)}
                                              </div>
                                              <div>
                                                  {createLabelControlFrag(oscLifecycle,
                                                      oscillators[sourceIndex].tune, 0.5)}
                                              </div>
                                              <div>
                                                  {createLabelControlFrag(oscLifecycle,
                                                      oscillators[sourceIndex].volume)}
                                              </div>
                                          </Frag>
                                      ))
                                  }))
                              }}>
                              </div>
                              <div style={{display: "contents"}}>
                                  <header>
                                      <FilterDisplay lifecycle={lifecycle}
                                                     cutoff={cutoff}
                                                     resonance={resonance}
                                                     order={filterOrder}/>
                                  </header>
                                  <div/>
                                  <div>{createLabelControlFrag(lifecycle, cutoff)}</div>
                                  <div>{createLabelControlFrag(lifecycle, resonance)}</div>
                                  <div>{createLabelControlFrag(lifecycle, filterEnvelope, 0.5)}</div>
                                  <div>{createLabelControlFrag(lifecycle, filterKeyboard, 0.5)}</div>
                                  <div>{createLabelControlFrag(lifecycle, filterOrder, 0.5)}</div>
                              </div>
                              <div style={{display: "contents"}}>
                                  <header>
                                      <WaveformDisplay lifecycle={lifecycle}
                                                       adapter={bindWaveformParameter(lifecycle, lfoWaveform)}/>
                                  </header>
                                  <div/>
                                  <div>{createWaveformSelector(lifecycle, lfoWaveform)}</div>
                                  <div>{createLabelControlFrag(lifecycle, lfoRate)}</div>
                                  <div>{createLabelControlFrag(lifecycle, lfoTargetTune, 0.5)}</div>
                                  <div>{createLabelControlFrag(lifecycle, lfoTargetCutoff, 0.5)}</div>
                                  <div>{createLabelControlFrag(lifecycle, lfoTargetVolume, 0.5)}</div>
                              </div>
                              <div style={{display: "contents"}}>
                                  <header>
                                      <EnvelopeDisplay lifecycle={lifecycle}
                                                       sustain={sustain}
                                                       receiver={liveStreamReceiver}
                                                       address={adapter.address.append(0)}/>
                                  </header>
                                  <div/>
                                  <div>{createLabelControlFrag(lifecycle, attack)}</div>
                                  <div>{createLabelControlFrag(lifecycle, decay)}</div>
                                  <div>{createLabelControlFrag(lifecycle, sustain)}</div>
                                  <div>{createLabelControlFrag(lifecycle, release)}</div>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Vaporisateur.defaultIcon}/>
    )
}