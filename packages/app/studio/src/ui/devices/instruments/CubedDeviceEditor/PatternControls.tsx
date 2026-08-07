import css from "./PatternControls.sass?inline"
import {clamp, DefaultObservableValue, Editing, int, Lifecycle, StringMapping, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {CubedDeviceBoxAdapter} from "@opendaw/studio-adapters"
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
    const clearActivePattern = () => editing.modify(() => adapter.clearCurrentPattern())
    const randomizeActivePattern = () => editing.modify(() => adapter.randomizeCurrentPattern())
    const rotateActivePattern = (offset: int) => editing.modify(() => adapter.rotateCurrentPattern(offset))
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
                <div className="group">
                    <Button lifecycle={lifecycle}
                            onClick={() => rotateActivePattern(1)}
                            appearance={{framed: true, color: Colors.blue}}>{"<"}</Button>
                    <Button lifecycle={lifecycle}
                            onClick={() => rotateActivePattern(-1)}
                            appearance={{framed: true, color: Colors.blue}}>{">"}</Button>
                </div>
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
                            appearance={{framed: true}}
                            elements={[16, 32, 48, 64].map(value => ({
                                value, element: (
                                    <span style={{margin: "0 1px"}}>{String(value)}</span>
                                )
                            }))}/>
            </div>
        </div>
    )
}
