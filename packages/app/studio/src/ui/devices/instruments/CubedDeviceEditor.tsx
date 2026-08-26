import css from "./CubedDeviceEditor.sass?inline"
import {DefaultObservableValue, int, Lifecycle, ValueGuide} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AutomatableParameterFieldAdapter, CubedDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Html} from "@opendaw/lib-dom"
import {MenuItem} from "@opendaw/studio-core"
import {CubedPatternActions} from "@/ui/devices/instruments/CubedDeviceEditor/CubedPatternActions"
import {StudioService} from "@/service/StudioService"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {Icon} from "@/ui/components/Icon"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {PatternControls} from "@/ui/devices/instruments/CubedDeviceEditor/PatternControls"
import {PatternGrid} from "@/ui/devices/instruments/CubedDeviceEditor/PatternGrid"
import {Colors, IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "CubedDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: CubedDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const CubedDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {tuning, cutoff, resonance, envMod, decay, accent, volume, waveform} = adapter.namedParameter
    const knob = (parameter: AutomatableParameterFieldAdapter, anchor?: number, options?: ValueGuide.Options) =>
        ControlBuilder.createKnob({
            lifecycle,
            editing,
            midiLearning,
            adapter,
            parameter,
            anchor,
            options,
            color: Colors.black
        })
    const stepRange = lifecycle.own(new DefaultObservableValue<int>(16))
    const patternContext = {editing, adapter}
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                          parent.addMenuItem(MenuItem.default({label: "Pattern", separatorBefore: true})
                              .setRuntimeChildrenProcedure(submenu => submenu.addMenuItem(
                                  ...CubedPatternActions.clipboardItems(patternContext),
                                  CubedPatternActions.loadAblItem(patternContext))))
                      }}
                      populateControls={() => (
                          <div className={className}>
                              <div className="controls">
                                  <div className="waveform">
                                      <AutomationControl lifecycle={lifecycle} editing={editing}
                                                         midiLearning={midiLearning}
                                                         tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                                                         parameter={waveform}>
                                          <RadioGroup lifecycle={lifecycle}
                                                      model={EditWrapper.forAutomatableParameter(editing, waveform)}
                                                      appearance={{landscape: true, activeColor: Colors.orange}}
                                                      elements={[
                                                          {value: 0, element: <Icon symbol={IconSymbol.Sawtooth}/>},
                                                          {value: 1, element: <Icon symbol={IconSymbol.Square}/>}
                                                      ]}/>
                                      </AutomationControl>
                                  </div>
                                  {knob(tuning, 0.5, {snap: {threshold: 0.5}})}
                                  {knob(cutoff)}
                                  {knob(resonance)}
                                  {knob(envMod)}
                                  {knob(decay)}
                                  {knob(accent)}
                                  {knob(volume)}
                              </div>
                              <div className="body">
                                  <PatternControls lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                                   adapter={adapter} stepRange={stepRange}/>
                                  <PatternGrid lifecycle={lifecycle} editing={editing} adapter={adapter}
                                               stepRange={stepRange} receiver={project.liveStreamReceiver}/>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={IconSymbol.Cube}/>
    )
}
