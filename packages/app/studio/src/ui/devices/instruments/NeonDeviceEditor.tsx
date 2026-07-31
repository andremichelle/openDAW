import css from "./NeonDeviceEditor.sass?inline"
import {DefaultObservableValue, int, Lifecycle, Terminator, tryCatch} from "@opendaw/lib-std"
import {Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {createElement, Frag, replaceChildren} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {
    AutomatableParameterFieldAdapter, CzSysex, DeviceHost, InstrumentFactories, Neon, NeonDeviceBoxAdapter, NeonPreset
} from "@opendaw/studio-adapters"
import {NeonEnvelope} from "@opendaw/studio-boxes"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {EnvelopeEditor} from "@/ui/devices/instruments/NeonDeviceEditor/EnvelopeEditor"
import {WaveDisplay} from "@/ui/devices/instruments/NeonDeviceEditor/WaveDisplay"

const className = Html.adoptStyleSheet(css, "NeonDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NeonDeviceBoxAdapter
    deviceHost: DeviceHost
}

const envRates = (envelope: NeonEnvelope) => [
    envelope.rate1, envelope.rate2, envelope.rate3, envelope.rate4,
    envelope.rate5, envelope.rate6, envelope.rate7, envelope.rate8
]
const envLevels = (envelope: NeonEnvelope) => [
    envelope.level1, envelope.level2, envelope.level3, envelope.level4,
    envelope.level5, envelope.level6, envelope.level7, envelope.level8
]

// Everything snaps to the canonical control grid (3.5em tracks). LEFT — GLOBAL (title-less radios over
// Octave/Detune/Glide knobs) and VIBRATO (shape icons in the strip, three knobs). RIGHT — LINE 1/LINE 2
// TABS over a tinted body holding the SELECTED line: Wave 1, Wave 2, key follows, copy, and the tabbed
// envelope canvas with the S/E marker lane. plans/neon.md "Editor".
export const NeonDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {
        lineSelect, modulation, octave, detune, glideTime, voicingMode, vibrato, lines
    } = adapter.namedParameter
    const box = adapter.box
    const knob = (parameter: AutomatableParameterFieldAdapter<number>, label?: string) =>
        ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter, label})
    const radioCell = (title: string, parameter: AutomatableParameterFieldAdapter<number>,
                       elements: ReadonlyArray<{value: number, tooltip?: string, element: HTMLElement | SVGSVGElement}>,
                       fontSize: string, span?: number) => (
        <div className="cell" style={span === undefined ? undefined : {gridColumn: `span ${span}`}}>
            <h3>{title}</h3>
            <RadioGroup lifecycle={lifecycle}
                        model={EditWrapper.forAutomatableParameter(editing, parameter)}
                        className="radios"
                        style={{fontSize}}
                        elements={elements}/>
        </div>
    )
    const flipped = (symbol: IconSymbol): HTMLElement => (
        <span style={{transform: "scaleX(-1)", display: "inline-flex"}}>
            <Icon symbol={symbol}/>
        </span>
    )
    const waveCell = (title: string, parameter: AutomatableParameterFieldAdapter<number>, offValue: boolean) => {
        const name: HTMLElement = (<span className="wave-name"/>)
        lifecycle.own(parameter.catchupAndSubscribe(() => name.textContent = parameter.getPrintValue().value))
        const display: HTMLElement = (
            <AutomationControl lifecycle={lifecycle}
                               editing={editing}
                               midiLearning={midiLearning}
                               tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                               parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle}
                                           editing={editing}
                                           parameter={parameter}>
                    <div className="wave-frame">
                        <WaveDisplay lifecycle={lifecycle} parameter={parameter} offValue={offValue}/>
                    </div>
                </RelativeUnitValueDragging>
            </AutomationControl>
        )
        return (
            <div className="cell">
                <h3>{title}</h3>
                {display}
                {name}
            </div>
        )
    }
    const loadPreset = async () => {
        const opened = await Promises.tryCatch(Files.open({
            types: [{description: "Casio CZ SysEx", accept: {"application/octet-stream": [".syx"]}}]
        }))
        if (opened.status === "rejected") {return}
        const [file] = opened.value
        const bytes = new Uint8Array(await file.arrayBuffer())
        const decoded = tryCatch(() => CzSysex.decode(bytes))
        if (decoded.status === "failure") {
            console.warn("Not a Casio CZ tone dump:", file.name, decoded.error)
            return
        }
        const name = file.name.replace(/\.syx$/i, "")
        editing.modify(() => {
            NeonPreset.apply(box, decoded.value)
            box.label.setValue(name)
        })
    }
    const copyLine = (from: 0 | 1, to: 0 | 1) => {
        const source = box.lines.fields()[from]
        const target = box.lines.fields()[to]
        const envelopes = box.envelopes.fields()
        editing.modify(() => {
            target.wave1.setValue(source.wave1.getValue())
            target.wave2.setValue(source.wave2.getValue())
            target.dcwKeyFollow.setValue(source.dcwKeyFollow.getValue())
            target.dcaKeyFollow.setValue(source.dcaKeyFollow.getValue())
            for (let kind = 0; kind < 3; kind++) {
                const sourceEnv = envelopes[from * 3 + kind]
                const targetEnv = envelopes[to * 3 + kind]
                envRates(sourceEnv).forEach((field, index) => envRates(targetEnv)[index].setValue(field.getValue()))
                envLevels(sourceEnv).forEach((field, index) => envLevels(targetEnv)[index].setValue(field.getValue()))
                targetEnv.sustain.setValue(sourceEnv.sustain.getValue())
                targetEnv.end.setValue(sourceEnv.end.getValue())
            }
        })
    }
    const lineIndex = lifecycle.own(new DefaultObservableValue<int>(0))
    const lineLifecycle = lifecycle.own(new Terminator())
    const lineCells: HTMLElement = (<div style={{display: "contents"}}/>)
    lifecycle.own(lineIndex.catchupAndSubscribe(owner => {
        lineLifecycle.terminate()
        const index = owner.getValue() as 0 | 1
        const other: 0 | 1 = index === 0 ? 1 : 0
        const copyButton: HTMLElement = (
            <span className="copy-button" onclick={() => copyLine(index, other)}>{`→ L${other + 1}`}</span>
        )
        lineLifecycle.own(TextTooltip.default(copyButton, () =>
            `Copy waves, key follows and all three envelopes of line ${index + 1} to line ${other + 1} (undoable)`))
        replaceChildren(lineCells, (
            <Frag>
                {waveCell("Wave 1", lines[index].wave1, false)}
                {waveCell("Wave 2", lines[index].wave2, true)}
                {knob(lines[index].dcwKeyFollow, "KF DCW")}
                {knob(lines[index].dcaKeyFollow, "KF DCA")}
                <div className="cell copy-cell">
                    {copyButton}
                </div>
            </Frag>
        ))
    }))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                          parent.addMenuItem(MenuItem.default({label: "Load Casio CZ .syx…", separatorBefore: true})
                              .setTriggerProcedure(() => {loadPreset().catch(console.warn)}))
                      }}
                      populateControls={() => (
                          <div className={className}>
                              <div className="block left">
                                  <div className="label play-section"/>
                                  <div className="label vibrato-section"/>
                                  {radioCell("LINES", lineSelect,
                                      Neon.LineSelect.map((label, index) => ({value: index, element: <span>{label}</span>})), "8px", 2)}
                                  {radioCell("MODE", modulation, [
                                      {value: 0, tooltip: "Off", element: <Icon symbol={IconSymbol.Sine}/>},
                                      {value: 1, tooltip: "Ring", element: <Icon symbol={IconSymbol.Ring}/>},
                                      {value: 2, tooltip: "Noise", element: <Icon symbol={IconSymbol.Noise}/>}
                                  ], "12px")}
                                  <div className="cell"/>
                                  {radioCell("Play-Mode", voicingMode, [
                                      {value: 0, element: <span>MONO</span>},
                                      {value: 1, element: <span>POLY</span>}
                                  ], "8px")}
                                  {knob(octave)}
                                  {knob(detune)}
                                  {knob(glideTime, "Glide time")}
                                  <div className="row-spacer"/>
                                  {radioCell("Vibrato", vibrato.wave, [
                                      {value: 0, tooltip: "Triangle", element: <Icon symbol={IconSymbol.Triangle}/>},
                                      {value: 1, tooltip: "Saw Up", element: <Icon symbol={IconSymbol.Sawtooth}/>},
                                      {value: 2, tooltip: "Saw Down", element: flipped(IconSymbol.Sawtooth)},
                                      {value: 3, tooltip: "Square", element: <Icon symbol={IconSymbol.Square}/>}
                                  ], "9px")}
                                  {knob(vibrato.delay, "Delay")}
                                  {knob(vibrato.rate, "Rate")}
                                  {knob(vibrato.depth, "Depth")}
                              </div>
                              <div className="block right">
                                  <div className="line-tabs">
                                      <RadioGroup lifecycle={lifecycle}
                                                  model={lineIndex}
                                                  className="tabs"
                                                  elements={[
                                                      {value: 0, element: <span>LINE 1</span>},
                                                      {value: 1, element: <span>LINE 2</span>}
                                                  ]}/>
                                  </div>
                                  <div className="line-body">
                                      <div className="cells">
                                          {lineCells}
                                      </div>
                                      <div className="envelopes">
                                          <EnvelopeEditor lifecycle={lifecycle}
                                                          editing={editing}
                                                          envelopes={box.envelopes.fields()}
                                                          lineIndex={lineIndex}/>
                                      </div>
                                  </div>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Neon.defaultIcon}/>
    )
}
