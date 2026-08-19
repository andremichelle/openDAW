import css from "./StepsEditor.sass?inline"
import {clamp, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StepsDirection, StepsModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ModulatorEditor} from "@/ui/modulation/ModulatorEditor.tsx"
import {StepsDisplay} from "@/ui/modulation/editors/StepsDisplay.tsx"
import {ModulatorKnob} from "@/ui/modulation/ModulatorKnob.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {NumberInput} from "@/ui/components/NumberInput.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "StepsEditor")

const StepsDirections = [
    {value: StepsDirection.Forward, symbol: IconSymbol.Forward},
    {value: StepsDirection.Backward, symbol: IconSymbol.Backward},
    {value: StepsDirection.PingPong, symbol: IconSymbol.PingPong},
    {value: StepsDirection.Alternate, symbol: IconSymbol.Alternate},
    {value: StepsDirection.Random, symbol: IconSymbol.Random}
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
                <div className="pattern">
                    <div className="steps">
                        <div className="count">
                            <h5>Steps</h5>
                            <NumberInput lifecycle={lifecycle}
                                         guard={{guard: value => clamp(value, 1, StepsModulatorBoxAdapter.MaxSteps)}}
                                         model={EditWrapper.forValue(editing, modulator.box.count)}/>
                        </div>
                        <div className="mode">
                            <h5>Mode</h5>
                            <RadioGroup lifecycle={lifecycle}
                                        model={EditWrapper.forValue(editing, modulator.box.direction)}
                                        elements={StepsDirections.map(({value, symbol}) => ({
                                            value, tooltip: StepsModulatorBoxAdapter.DirectionStrings[value],
                                            element: (<Icon symbol={symbol}/>)
                                        }))}
                                        appearance={{color: Colors.shadow, activeColor: Colors.blue}}/>
                        </div>
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
                </div>
                <div className="knobs">
                    <div className="section"/>
                    {[rateSync, rateAbsolute, smooth, phase, amount].map(parameter => (
                        <ModulatorKnob lifecycle={lifecycle} service={service} parameter={parameter}/>
                    ))}
                </div>
            </div>
        </ModulatorEditor>
    )
}
