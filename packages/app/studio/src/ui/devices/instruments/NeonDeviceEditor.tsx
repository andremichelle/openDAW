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
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
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

// The Vaporisateur editor language: SECTION ROWS, each a tinted band holding the parameter names with
// the values beneath — GLOBAL, VIBRATO (one line), LINE (follows the L1/L2 edit selector) and the
// envelope canvas. plans/neon.md "Editor".
export const NeonDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {
        lineSelect, modulation, octave, detune, glideTime, voicingMode, vibrato, lines
    } = adapter.namedParameter
    const box = adapter.box
    const valueLabel = (parameter: AutomatableParameterFieldAdapter<number>, threshold?: number) => (
        <AutomationControl lifecycle={lifecycle}
                           editing={editing}
                           midiLearning={midiLearning}
                           tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                           parameter={parameter}>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}
                                       options={threshold === undefined ? undefined : {snap: {threshold}}}
                                       supressValueFlyout={true}>
                <ParameterLabel lifecycle={lifecycle}
                                parameter={parameter}
                                classList={["center"]}
                                framed={true}/>
            </RelativeUnitValueDragging>
        </AutomationControl>
    )
    const cell = (title: string, parameter: AutomatableParameterFieldAdapter<number>, threshold?: number) => (
        <div className="cell">
            <h3>{title}</h3>
            {valueLabel(parameter, threshold)}
        </div>
    )
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
    lifecycle.own(lineIndex.catchupAndSubscribe(owner => {
        lineLifecycle.terminate()
        const index = owner.getValue() as 0 | 1
        const other: 0 | 1 = index === 0 ? 1 : 0
        const copyButton: HTMLElement = (
            <span className="copy-button" onclick={() => copyLine(index, other)}>{`copy → L${other + 1}`}</span>
        )
        lineLifecycle.own(TextTooltip.default(copyButton, () => `Copy line ${index + 1} to line ${other + 1}`))
        replaceChildren(lineCells, (
            <Frag>
                {waveCell("Wave 1", lines[index].wave1, false)}
                {waveCell("Wave 2", lines[index].wave2, true)}
                {cell("KF DCW", lines[index].dcwKeyFollow)}
                {cell("KF DCA", lines[index].dcaKeyFollow)}
                <div className="cell">
                    <h3>Copy</h3>
                    {copyButton}
                </div>
            </Frag>
        ))
    }))
    const editRadio: HTMLElement = (
        <div className="cell">
            <h3>Edit</h3>
            <RadioGroup lifecycle={lifecycle}
                        model={lineIndex}
                        className="radios"
                        style={{fontSize: "8px"}}
                        elements={[
                            {value: 0, element: <span>LINE 1</span>},
                            {value: 1, element: <span>LINE 2</span>}
                        ]}/>
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
                              <div className="globals">
                                  <div className="label global-section"/>
                                  <div className="label vibrato-section"/>
                                  {radioCell("Line", lineSelect, Neon.LineSelect)}
                                  {iconRadioCell("Mod", modulation, [
                                      {symbol: IconSymbol.Close, name: "Off"},
                                      {symbol: IconSymbol.Ring, name: "Ring"},
                                      {symbol: IconSymbol.Noise, name: "Noise"}
                                  ])}
                                  {radioCell("Play-Mode", voicingMode, ["MONO", "POLY"], [0, 1])}
                                  {cell("Octave", octave, 0.5)}
                                  {cell("Glide", glideTime)}
                                  {cell("Detune", detune, 0.5)}
                                  <div className="cell"/>
                                  <div className="cell"/>
                                  {iconRadioCell("Vibrato", vibrato.wave, [
                                      {symbol: IconSymbol.Triangle, name: "Triangle"},
                                      {symbol: IconSymbol.Sawtooth, name: "Saw Up"},
                                      {symbol: IconSymbol.Sawtooth, flip: true, name: "Saw Down"},
                                      {symbol: IconSymbol.Square, name: "Square"}
                                  ])}
                                  {cell("Delay", vibrato.delay)}
                                  {cell("Rate", vibrato.rate)}
                                  {cell("Depth", vibrato.depth)}
                              </div>
                              <div className="line-side">
                                  <div className="label line-section"/>
                                  <div className="label envelope-section"/>
                                  {editRadio}
                                  {lineCells}
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
