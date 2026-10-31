import css from "./MasteringPanel.sass?inline"
import {
    DefaultObservableValue,
    DefaultParameter,
    EmptyExec,
    Lifecycle,
    Parameter,
    StringMapping,
    ValueMapping
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MixdownSection} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {Knob} from "@/ui/components/Knob"
import {DropDown} from "@/ui/composite/DropDown"
import {Column} from "@/ui/devices/Column"
import {LKR} from "@/ui/devices/constants"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {FlexSpacer} from "@/ui/components/FlexSpacer"

const className = Html.adoptStyleSheet(css, "MasteringPanel")

const FrequencyTicks = [
    {hz: 50, label: "50"}, {hz: 100, label: "100"}, {hz: 300, label: "300"}, {hz: 1000, label: "1k"},
    {hz: 3000, label: "3k"}, {hz: 10000, label: "10k"}
]
const GainTicks = [12, 6, 0, -6, -12]

// placeholder entries: built-in profiles, then user profiles
const ReferenceProfiles = ["Balanced", "Warm", "Bright", "Punchy", "My Reference"]

const frequencyToX = (hz: number): number => Math.log(hz / 20) / Math.log(1000)
const gainToY = (db: number): number => 50 - db * 40 / 12
const bump = (x: number, center: number, width: number, db: number): number =>
    db * Math.exp(-(((x - center) / width) ** 2))

// placeholder curve until the analysis runs
const correctionPoints = (): ReadonlyArray<[number, number]> =>
    Array.from({length: 240}, (_, index) => {
        const x = index / 239
        const db = bump(x, 0.16, 0.07, -4.5) + bump(x, 0.3, 0.05, -2) + bump(x, 0.5, 0.05, 2.5)
            + bump(x, 0.58, 0.015, -3) + bump(x, 0.72, 0.07, 2.8) + Math.sin(x * 140) * 0.4 * Math.sin(x * Math.PI)
        return [x * 400, gainToY(db)]
    })

const strokePath = (points: ReadonlyArray<[number, number]>): string =>
    points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MasteringPanel = ({lifecycle, service}: Construct) => {
    const {project} = service
    const sections = MixdownSection.collect(project)
    const enabled = new DefaultObservableValue(true)
    const limiter = new DefaultObservableValue(true)
    const compare = new DefaultObservableValue(false)
    const gain = lifecycle.own(new DefaultParameter(ValueMapping.linear(-12.0, 12.0),
        StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Gain", 0.0))
    const ceiling = lifecycle.own(new DefaultParameter(ValueMapping.linear(-6.0, 0.0),
        StringMapping.numeric({unit: "dB", fractionDigits: 1}), "Ceiling", -0.3))
    const width = lifecycle.own(new DefaultParameter(ValueMapping.linear(0.0, 2.0),
        StringMapping.percent({fractionDigits: 0}), "Width", 1.0))
    const points = correctionPoints()
    const renderMeter = (label: string, fill: number, scale: [string, string]) => (
        <div className="meter">
            <span className="label">{label}</span>
            <div className="track">
                <div className="bar" style={{width: `${fill * 100}%`}}/>
            </div>
            <span className="scale">{scale[0]}</span>
            <span className="scale end">{scale[1]}</span>
        </div>
    )
    const renderKnob = (parameter: Parameter<number>, anchor: number) => {
        const value: HTMLElement = (<span className="value"/>)
        lifecycle.own(parameter.catchupAndSubscribe(() => {
            const {value: printValue, unit} = parameter.getPrintValue()
            value.textContent = `${printValue}${unit}`
        }))
        return (
            <Column ems={LKR} color={Colors.cream}>
                <h5>{parameter.name}</h5>
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={project.editing} parameter={parameter}>
                    <Knob lifecycle={lifecycle} value={parameter} anchor={anchor}/>
                </RelativeUnitValueDragging>
                {value}
            </Column>
        )
    }
    return (
        <div className={className}>
            <header>
                <Checkbox lifecycle={lifecycle} model={enabled}
                          appearance={{color: Colors.shadow, activeColor: Colors.blue, cursor: "pointer"}}>
                    <Icon symbol={IconSymbol.Shutdown}/>
                </Checkbox>
                <h1>Mastering</h1>
            </header>
            <div className="body">
                <div className="eq">
                    <div className="amount">
                        <div className="slider">
                            <div className="track"/>
                            <div className="thumb"/>
                        </div>
                        <h5>Amount</h5>
                        <span className="value">100%</span>
                    </div>
                    <div className="display">
                        <svg viewBox="0 0 400 100" preserveAspectRatio="none">
                            {FrequencyTicks.map(({hz}) => (
                                <line className="grid" x1={frequencyToX(hz) * 400} y1="0"
                                      x2={frequencyToX(hz) * 400} y2="100"/>
                            ))}
                            {GainTicks.map(db => (
                                <line className={db === 0 ? "zero" : "grid"} x1="0" y1={gainToY(db)}
                                      x2="400" y2={gainToY(db)}/>
                            ))}
                            <path className="fill" d={`${strokePath(points)} L400 50 L0 50 Z`}/>
                            <path className="curve" d={strokePath(points)}/>
                        </svg>
                        <div className="gain-axis">
                            {GainTicks.map(db => (
                                <span style={{top: `${gainToY(db)}%`}}>{db > 0 ? `+${db}` : db}</span>
                            ))}
                        </div>
                        <div className="frequency-axis">
                            {FrequencyTicks.map(({hz, label}) => (
                                <span style={{left: `${frequencyToX(hz) * 100}%`}}>{label}</span>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="sections">
                    <section className="reference">
                        <h3>Reference</h3>
                        <div className="drop-down">
                            <DropDown lifecycle={lifecycle}
                                      owner={new DefaultObservableValue(ReferenceProfiles[0])}
                                      provider={() => ReferenceProfiles}
                                      mapping={profile => profile}
                                      width="8em"/>
                        </div>
                        <Button lifecycle={lifecycle} onClick={EmptyExec}
                                appearance={{
                                    color: Colors.shadow, framed: true,
                                    tooltip: "Analyse an audio file as reference (or drop one here)"
                                }}>
                            <Icon symbol={IconSymbol.FolderOpen}/>
                        </Button>
                    </section>
                    <section>
                        <h3>Dynamics</h3>
                        <div className="row">
                            {renderKnob(gain, 0.5)}
                            {renderKnob(ceiling, 1.0)}
                            <Column ems={LKR} color={Colors.cream}>
                                <h5>Limiter</h5>
                                <Checkbox lifecycle={lifecycle} model={limiter}
                                          appearance={{color: Colors.shadow, activeColor: Colors.blue, framed: true}}>
                                    <span>On</span>
                                </Checkbox>
                            </Column>
                        </div>
                    </section>
                    <section>
                        <h3>Spread</h3>
                        <div className="row">
                            {renderKnob(width, 0.5)}
                        </div>
                    </section>
                    <section className="meters">
                        <h3>Meters</h3>
                        {renderMeter("Peak", 0.82, ["-60", "0"])}
                        {renderMeter("LUFS Short-Term", 0.7, ["-60", "0"])}
                        {renderMeter("LUFS Integrated", 0.66, ["-60", "0"])}
                        {renderMeter("Correlation", 0.78, ["-1", "+1"])}
                    </section>
                </div>
            </div>
            <footer>
                <Button lifecycle={lifecycle} onClick={EmptyExec} appearance={{color: Colors.blue, framed: true}}>
                    <span>Analyse</span>
                </Button>
                <FlexSpacer pixels={4}/>
                <div className="drop-down">
                    <DropDown lifecycle={lifecycle}
                              owner={new DefaultObservableValue(sections[0])}
                              provider={() => sections}
                              mapping={section => section.label}
                              appearance={{color: Colors.shadow, framed: true}}
                              width="8em"/>
                </div>
                <div className="spacer"/>
                <Checkbox lifecycle={lifecycle} model={compare}
                          appearance={{
                              color: Colors.shadow, activeColor: Colors.orange, framed: true,
                              tooltip: "Compare original and mastered at the same loudness"
                          }}>
                    <span>Compare</span>
                </Checkbox>
            </footer>
        </div>
    )
}
