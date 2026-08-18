import css from "./StepsEditor.sass?inline"
import {clamp, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {StepsDirection, StepsModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ModulatorEditor} from "@/ui/modulation/ModulatorEditor.tsx"
import {StepsDisplay} from "@/ui/modulation/editors/StepsDisplay.tsx"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob.tsx"
import {Column} from "@/ui/devices/Column.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {NumberInput} from "@/ui/components/NumberInput.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {LKR} from "@/ui/devices/constants.ts"

const className = Html.adoptStyleSheet(css, "StepsEditor")

const StepsDirections = [
    {value: StepsDirection.Forward, glyph: "→"},
    {value: StepsDirection.Backward, glyph: "←"},
    {value: StepsDirection.PingPong, glyph: "↔"},
    {value: StepsDirection.Alternate, glyph: "⇄"},
    {value: StepsDirection.Random, glyph: "✳"}
] as const

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: StepsModulatorBoxAdapter
}

export const StepsEditor = ({lifecycle, service, modulator}: Construct) => {
    const {editing, liveStreamReceiver} = service.project
    const {rateSync, rateAbsolute, smooth, phase, amount} = modulator.namedParameter
    return (
        <ModulatorEditor lifecycle={lifecycle} service={service} modulator={modulator}>
            <div className={className}>
                <StepsDisplay lifecycle={lifecycle} editing={editing}
                              receiver={liveStreamReceiver} modulator={modulator}/>
                <div className="controls">
                    <div className="steps">
                        <div className="count">
                            <h5>Steps</h5>
                            <NumberInput lifecycle={lifecycle}
                                         guard={{guard: value => clamp(value, 1, StepsModulatorBoxAdapter.MaxSteps)}}
                                         model={EditWrapper.forValue(editing, modulator.box.count)}/>
                        </div>
                        <div className="buttons">
                            <Button lifecycle={lifecycle}
                                    onClick={() => editing.modify(() => modulator.randomize())}
                                    appearance={{framed: true, color: Colors.orange}}>Random</Button>
                            <Button lifecycle={lifecycle}
                                    onClick={() => editing.modify(() => modulator.rotate(-1))}
                                    appearance={{framed: true, color: Colors.blue}}>{"<"}</Button>
                            <Button lifecycle={lifecycle}
                                    onClick={() => editing.modify(() => modulator.rotate(1))}
                                    appearance={{framed: true, color: Colors.blue}}>{">"}</Button>
                            <Button lifecycle={lifecycle}
                                    onClick={() => editing.modify(() => modulator.clear())}
                                    appearance={{framed: true, color: Colors.green}}>Clear</Button>
                        </div>
                        <RadioGroup lifecycle={lifecycle}
                                    model={EditWrapper.forValue(editing, modulator.box.direction)}
                                    elements={StepsDirections.map(({value, glyph}) => ({
                                        value, tooltip: StepsModulatorBoxAdapter.DirectionStrings[value],
                                        element: (<span>{glyph}</span>)
                                    }))}
                                    appearance={{framed: true, color: Colors.blue}}/>
                    </div>
                    <div className="knobs">
                        <div className="section"/>
                        {[rateSync, rateAbsolute, smooth, phase, amount].map(parameter => (
                            <Column ems={LKR}>
                                <h5>{parameter.name}</h5>
                                <ParameterLabelKnob lifecycle={lifecycle} editing={editing} parameter={parameter}/>
                            </Column>
                        ))}
                    </div>
                </div>
            </div>
        </ModulatorEditor>
    )
}
