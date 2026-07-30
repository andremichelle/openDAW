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

// TWO balanced columns in the house control language (ControlBuilder knobs + section strips):
// LEFT — GLOBAL (radios, then Octave/Detune/Glide knobs) and VIBRATO (shape + three knobs, one row).
// RIGHT — LINE (Edit L1/L2 chips + copy in the strip, wave glyphs + key-follow knobs) over the tabbed
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
                       labels: ReadonlyArray<string>, values?: ReadonlyArray<number>) => (
        <div className="cell">
            <h3>{title}</h3>
            <RadioGroup lifecycle={lifecycle}
                        model={EditWrapper.forAutomatableParameter(editing, parameter)}
                        className="radios"
                        style={{fontSize: "8px"}}
                        elements={labels.map((label, index) => ({
                            value: values === undefined ? index : values[index],
                            element: <span>{label}</span>
                        }))}/>
        </div>
    )
    const iconRadioCell = (title: string, parameter: AutomatableParameterFieldAdapter<number>,
                           icons: ReadonlyArray<{symbol: IconSymbol, flip?: boolean, name: string}>) => (
        <div className="cell">
            <h3>{title}</h3>
            <RadioGroup lifecycle={lifecycle}
                        model={EditWrapper.forAutomatableParameter(editing, parameter)}
                        className="radios"
                        style={{fontSize: "9px"}}
                        elements={icons.map(({symbol, flip, name}, index) => ({
                            value: index,
                            tooltip: name,
                            element: (
                                <span style={flip === true ? {transform: "scaleX(-1)", display: "inline-flex"} : {display: "inline-flex"}}>
                                    <Icon symbol={symbol}/>
                                </span>
                            )
                        }))}/>
        </div>
    )
    const waveCell = (title: string, parameter: AutomatableParameterFieldAdapter<number>, offValue: boolean) => {
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
        lifecycle.own(TextTooltip.default(display, () => {
            const printValue = parameter.getPrintValue()
            return `${parameter.name}: ${printValue.value}`
        }))
        return (
            <div className="cell">
                <h3>{title}</h3>
                {display}
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
    const copySlot: HTMLElement = (<span className="copy-slot"/>)
    lifecycle.own(lineIndex.catchupAndSubscribe(owner => {
        lineLifecycle.terminate()
        const index = owner.getValue() as 0 | 1
        const other: 0 | 1 = index === 0 ? 1 : 0
        const copyButton: HTMLElement = (
            <span className="copy-button" onclick={() => copyLine(index, other)}>{`copy → L${other + 1}`}</span>
        )
        lineLifecycle.own(TextTooltip.default(copyButton, () =>
            `Copy waves, key follows and all three envelopes of line ${index + 1} to line ${other + 1} (undoable)`))
        replaceChildren(copySlot, copyButton)
        replaceChildren(lineCells, (
            <Frag>
                {waveCell("Wave 1", lines[index].wave1, false)}
                {waveCell("Wave 2", lines[index].wave2, true)}
                {knob(lines[index].dcwKeyFollow, "KF DCW")}
                {knob(lines[index].dcaKeyFollow, "KF DCA")}
            </Frag>
        ))
    }))
    const strip = (title: string, kind: string, extra?: HTMLElement) => (
        <div className={`strip ${kind}`}>
            <span>{title}</span>
            {extra}
        </div>
    )
    const editChips: HTMLElement = (
        <div className="edit-chips">
            <RadioGroup lifecycle={lifecycle}
                        model={lineIndex}
                        className="radios edit-line"
                        style={{fontSize: "8px"}}
                        elements={[
                            {value: 0, element: <span>L1</span>},
                            {value: 1, element: <span>L2</span>}
                        ]}/>
            {copySlot}
        </div>
    )
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
                              <div className="column-left">
                                  {strip("GLOBAL", "global")}
                                  <div className="row radios-row">
                                      {radioCell("Line", lineSelect, Neon.LineSelect)}
                                      {iconRadioCell("Mod", modulation, [
                                          {symbol: IconSymbol.Close, name: "Off"},
                                          {symbol: IconSymbol.Ring, name: "Ring"},
                                          {symbol: IconSymbol.Noise, name: "Noise"}
                                      ])}
                                      {radioCell("Play", voicingMode, ["MONO", "POLY"], [0, 1])}
                                  </div>
                                  <div className="row knobs-row">
                                      {knob(octave)}
                                      {knob(detune)}
                                      {knob(glideTime, "Glide")}
                                  </div>
                                  {strip("VIBRATO", "vibrato")}
                                  <div className="row knobs-row vibrato-row">
                                      <div className="shape-cell">
                                          {iconRadioCell("Shape", vibrato.wave, [
                                              {symbol: IconSymbol.Triangle, name: "Triangle"},
                                              {symbol: IconSymbol.Sawtooth, name: "Saw Up"},
                                              {symbol: IconSymbol.Sawtooth, flip: true, name: "Saw Down"},
                                              {symbol: IconSymbol.Square, name: "Square"}
                                          ])}
                                      </div>
                                      {knob(vibrato.delay, "Delay")}
                                      {knob(vibrato.rate, "Rate")}
                                      {knob(vibrato.depth, "Depth")}
                                  </div>
                              </div>
                              <div className="column-right">
                                  {strip("LINE", "line", editChips)}
                                  <div className="row knobs-row">
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
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Neon.defaultIcon}/>
    )
}
