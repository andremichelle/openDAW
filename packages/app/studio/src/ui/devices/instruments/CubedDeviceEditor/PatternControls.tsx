import css from "./PatternControls.sass?inline"
import {clamp, DefaultObservableValue, Editing, int, Lifecycle, StringMapping, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {CubedDeviceBoxAdapter, CubedStep} from "@opendaw/studio-adapters"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {NumberInput} from "@/ui/components/NumberInput"
import {Button} from "@/ui/components/Button"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "CubedPatternControls")

// pattern-index is stored 0-based but shown 1-based
const OneBasedIndex: StringMapping<number> = {
    x: value => ({unit: "", value: String(value + 1)}),
    y: text => {
        const value = parseInt(text, 10)
        return isNaN(value) ? {type: "unknown", value: text} : {type: "explicit", value: value - 1}
    }
}

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: CubedDeviceBoxAdapter
    stepRange: DefaultObservableValue<int>
}

export const PatternControls = ({lifecycle, editing, adapter, stepRange}: Construct) => {
    const {patternIndex} = adapter.namedParameter
    const defaultStep = CubedStep.pack({note: CubedStep.DefaultNote, active: false, slide: false, accent: false})
    const clearActivePattern = () => editing.modify(() =>
        adapter.currentPattern().steps.fields().forEach(field => field.setValue(defaultStep)))
    const CMinor = [0, 2, 3, 5, 7, 8, 10]
    const randomStep = (): int => CubedStep.pack({
        note: 36 + Math.floor(Math.random() * 3) * 12 + CMinor[Math.floor(Math.random() * CMinor.length)],
        active: Math.random() < 0.6,
        slide: Math.random() < 0.2,
        accent: Math.random() < 0.3
    })
    const randomizeActivePattern = () => editing.modify(() => {
        const pattern = adapter.currentPattern()
        const length = pattern.length.getValue()
        pattern.steps.fields().forEach((field, index) => field.setValue(index < length ? randomStep() : defaultStep))
    })
    return (
        <div className={className}>
            <div className="field">
                <label>Pattern</label>
                <NumberInput lifecycle={lifecycle} mapper={OneBasedIndex}
                             guard={{guard: value => clamp(value, 0, adapter.box.patterns.fields().length - 1)}}
                             model={EditWrapper.forValue(editing, adapter.box.patternIndex)}/>
            </div>
            <div className="field">
                <Button lifecycle={lifecycle}
                        onClick={randomizeActivePattern}
                        appearance={{framed: true, color: Colors.orange}}>Random</Button>
                <Button lifecycle={lifecycle}
                        onClick={clearActivePattern}
                        appearance={{framed: true, color: Colors.green}}>Clear</Button>
            </div>
            <div className="field">
                <label>Length</label>
                <div className="length" onInit={element => {
                    const inner = lifecycle.own(new Terminator())
                    lifecycle.own(patternIndex.catchupAndSubscribe(() => {
                        inner.terminate()
                        const pattern = adapter.currentPattern()
                        replaceChildren(element, (
                            <NumberInput lifecycle={inner}
                                         guard={{guard: value => clamp(value, 1, pattern.steps.fields().length)}}
                                         model={EditWrapper.forValue(editing, pattern.length)}/>
                        ))
                    }))
                }}/>
            </div>
            <div className="field">
                <label>Steps</label>
                <RadioGroup lifecycle={lifecycle}
                            model={stepRange}
                            elements={[16, 32, 48, 64].map(value => ({value, element: <span>{String(value)}</span>}))}/>
            </div>
        </div>
    )
}
