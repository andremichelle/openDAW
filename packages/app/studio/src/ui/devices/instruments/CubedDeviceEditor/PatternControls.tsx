import css from "./PatternControls.sass?inline"
import {clamp, DefaultObservableValue, Editing, int, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {CubedDeviceBoxAdapter, CubedRandomize, CubedRandomizeOptions} from "@opendaw/studio-adapters"
import {ContextMenu, MIDILearning} from "@opendaw/studio-core"
import {CubedPatternActions} from "@/ui/devices/instruments/CubedDeviceEditor/CubedPatternActions"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {NumberInput} from "@/ui/components/NumberInput"
import {Button} from "@/ui/components/Button"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {showRandomizeDialog} from "@/ui/devices/instruments/CubedDeviceEditor/RandomizeDialog"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "CubedPatternControls")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    midiLearning: MIDILearning
    adapter: CubedDeviceBoxAdapter
    stepRange: DefaultObservableValue<int>
}

export const PatternControls = ({lifecycle, editing, midiLearning, adapter, stepRange}: Construct) => {
    const {patternIndex} = adapter.namedParameter
    const randomizeOptions = lifecycle.own(
        new DefaultObservableValue<CubedRandomizeOptions>(CubedRandomize.Default))
    const clearActivePattern = () => editing.modify(() => adapter.clearCurrentPattern())
    const randomizeActivePattern = (options: CubedRandomizeOptions) =>
        editing.modify(() => adapter.randomizeCurrentPattern(options))
    const rotateActivePattern = (offset: int) => editing.modify(() => adapter.rotateCurrentPattern(offset))
    const onRandomClick = (event: MouseEvent) => {
        if (event.shiftKey) {
            showRandomizeDialog(randomizeOptions.getValue(), options => {
                randomizeOptions.setValue(options)
                randomizeActivePattern(options)
            }, options => randomizeOptions.setValue(options))
        } else {
            randomizeActivePattern(randomizeOptions.getValue())
        }
    }
    return (
        <div className={className}>
            <div className="field" onInit={element =>
                lifecycle.own(ContextMenu.subscribe(element, collector => collector.addItems(
                    ...CubedPatternActions.clipboardItems({editing, adapter, origin: element}))))}>
                <label>Pattern</label>
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                                   parameter={patternIndex} offset={2}>
                    <NumberInput lifecycle={lifecycle} mapper={patternIndex.stringMapping}
                                 guard={{guard: value => clamp(value, 0, adapter.box.patterns.fields().length - 1)}}
                                 model={EditWrapper.forAutomatableParameter(editing, patternIndex)}/>
                </AutomationControl>
            </div>
            <div className="field">
                <Button lifecycle={lifecycle}
                        onClick={onRandomClick}
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
                            elements={[16, 32, 48, 64].map(value => ({
                                value, element: (
                                    <span style={{margin: "0 1px"}}>{String(value)}</span>
                                )
                            }))}/>
            </div>
        </div>
    )
}
