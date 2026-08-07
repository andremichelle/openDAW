import css from "./CubedDeviceEditor.sass?inline"
import {DefaultObservableValue, int, Lifecycle, tryCatch, ValueGuide} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AblPattern, AutomatableParameterFieldAdapter, CubedDeviceBoxAdapter, CubedStep, DeviceHost} from "@opendaw/studio-adapters"
import {Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {MenuItem} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {RadioGroup} from "@/ui/components/RadioGroup"
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
    // Loads an AudioRealism .pat into the CURRENT pattern, leaving the other 15 untouched. Steps
    // beyond the file's length are cleared rather than left over, so a short pattern loaded over a
    // long one does not keep playing the tail of what was there before.
    const loadPattern = async () => {
        const opened = await Promises.tryCatch(Files.open({
            types: [{description: "AudioRealism ABL pattern", accept: {"text/plain": [".pat"]}}]
        }))
        if (opened.status === "rejected") {return}
        const [file] = opened.value
        const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()))
        const parsed = tryCatch(() => AblPattern.parse(text))
        if (parsed.status === "failure" || parsed.value.steps.length === 0) {
            console.warn("Not a readable ABL pattern:", file.name)
            return
        }
        const {steps, length} = parsed.value
        editing.modify(() => {
            const pattern = adapter.currentPattern()
            const capacity = pattern.steps.fields().length
            const used = Math.min(length, capacity)
            for (let index = 0; index < capacity; index++) {
                const step = index < used
                    ? steps[index]
                    : {note: CubedStep.DefaultNote, active: false, slide: false, accent: false}
                pattern.steps.getField(index).setValue(CubedStep.pack(step))
            }
            pattern.length.setValue(Math.max(1, used))
        })
    }
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                          parent.addMenuItem(MenuItem.default({label: "Load ABL .pat…", separatorBefore: true})
                              .setTriggerProcedure(() => {loadPattern().catch(console.warn)}))
                      }}
                      populateControls={() => (
                          <div className={className}>
                              <div className="controls">
                                  <div className="waveform">
                                      <RadioGroup lifecycle={lifecycle}
                                                  model={EditWrapper.forAutomatableParameter(editing, waveform)}
                                                  appearance={{landscape: true, activeColor: Colors.orange}}
                                                  elements={[
                                                      {value: 0, element: <Icon symbol={IconSymbol.Sawtooth}/>},
                                                      {value: 1, element: <Icon symbol={IconSymbol.Square}/>}
                                                  ]}/>
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
                                  <PatternControls lifecycle={lifecycle} editing={editing} adapter={adapter}
                                                   stepRange={stepRange}/>
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
