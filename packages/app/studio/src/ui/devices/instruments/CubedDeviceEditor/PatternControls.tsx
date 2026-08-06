import css from "./PatternControls.sass?inline"
import {DefaultObservableValue, Editing, int, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {CubedDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {NumberInput} from "@/ui/components/NumberInput"
import {Button} from "@/ui/components/Button"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "CubedPatternControls")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: CubedDeviceBoxAdapter
}

export const PatternControls = ({lifecycle, editing, adapter}: Construct) => {
    const {patternIndex} = adapter.namedParameter
    const stepRange = lifecycle.own(new DefaultObservableValue<int>(16))
    const currentPatternIndex = (): int => adapter.box.patternIndex.getValue()
    const patternAt = (index: int) => adapter.patterns.getAdapterByIndex(index)
    const clearActivePattern = () => patternAt(currentPatternIndex()).ifSome(pattern =>
        editing.modify(() => pattern.box.steps.fields().forEach(field => field.setValue(0))))
    return (
        <div className={className}>
            <div className="field">
                <label>Pattern</label>
                <NumberInput lifecycle={lifecycle} model={EditWrapper.forValue(editing, adapter.box.patternIndex)}/>
            </div>
            <Button lifecycle={lifecycle} onClick={clearActivePattern} appearance={{framed: true}}>Clear</Button>
            <div className="field">
                <label>Length</label>
                <div className="length" onInit={element => {
                    const inner = lifecycle.own(new Terminator())
                    lifecycle.own(patternIndex.catchupAndSubscribe(() => {
                        inner.terminate()
                        const model = patternAt(currentPatternIndex()).match({
                            some: pattern => EditWrapper.forValue(editing, pattern.box.length),
                            none: () => inner.own(new DefaultObservableValue<int>(16))
                        })
                        replaceChildren(element, <NumberInput lifecycle={inner} model={model}/>)
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
