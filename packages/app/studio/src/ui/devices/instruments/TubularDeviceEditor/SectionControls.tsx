import {Color, int, Lifecycle, MutableObservableValue, ObservableValue, Observer, Procedure} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter, TubularDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

export type SectionConstruct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: TubularDeviceBoxAdapter
    selectTab: Procedure<int>
}

// Vaporisateur's label control: caption over a framed, draggable value.
export const labelControl = ({lifecycle, service, adapter}: SectionConstruct,
                             parameter: AutomatableParameterFieldAdapter<number>, name?: string, span = 1) => {
    const {editing, midiLearning} = service.project
    return (
        <div className="control" style={{gridColumn: `span ${span}`}}>
            <h3>{name ?? parameter.name}</h3>
            <AutomationControl lifecycle={lifecycle}
                               editing={editing}
                               midiLearning={midiLearning}
                               tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                               parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle}
                                           editing={editing}
                                           parameter={parameter}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]} framed={true}/>
                </RelativeUnitValueDragging>
            </AutomationControl>
        </div>
    )
}

export type RadioElement = {value: number, tooltip?: string, element: HTMLElement | SVGSVGElement}

export const labelRadio = (lifecycle: Lifecycle, title: string, model: MutableObservableValue<number>,
                           elements: ReadonlyArray<string> | ReadonlyArray<RadioElement>, span = 1, fontSize = "9px") => (
    <div className="control" style={{gridColumn: `span ${span}`}}>
        <h3>{title}</h3>
        <RadioGroup lifecycle={lifecycle}
                    model={model}
                    style={{fontSize}}
                    elements={elements.map((entry, value) =>
                        typeof entry === "string" ? {value, element: <span>{entry}</span>} : entry)}/>
    </div>
)

// A 0/1 choice parameter (the DX7 switches) as a boolean model.
const booleanModel = (model: MutableObservableValue<number>): MutableObservableValue<boolean> =>
    new class implements MutableObservableValue<boolean> {
        getValue() {return model.getValue() > 0}
        setValue(value: boolean): void {model.setValue(value ? 1 : 0)}
        subscribe(observer: Observer<ObservableValue<boolean>>) {return model.subscribe(() => observer(this))}
        catchupAndSubscribe(observer: Observer<ObservableValue<boolean>>) {
            observer(this)
            return this.subscribe(observer)
        }
    }

export const labelSwitch = (lifecycle: Lifecycle, title: string, model: MutableObservableValue<number>, tooltip: string) => (
    <div className="control">
        <h3>{title}</h3>
        <Checkbox lifecycle={lifecycle}
                  model={booleanModel(model)}
                  style={{fontSize: "10px"}}
                  appearance={{cursor: "pointer", tooltip}}>
            <Icon symbol={IconSymbol.Shutdown}/>
        </Checkbox>
    </div>
)

// Gate/Delay's tinted, bordered section behind a group of controls and, when it reaches the trailing
// column, Delay's rotated title flush with its right edge.
export const band = (color: Color, rows: [int, int], columns: [int, int], title?: string) => [
    <div className="label" style={{gridArea: `${rows[0]} / ${columns[0]} / ${rows[1]} / ${title === undefined ? columns[1] : 9}`, "--color": color.toString()}}/>,
    title === undefined ? null
        : <h3 className="rotated" style={{gridArea: `${rows[0]} / 8 / ${rows[1]} / 9`, "--color": color.toString()}}>{title}</h3>
]

// An operator in the ALGO overview: name, level and switch stacked in one control.
export const labelStack = ({lifecycle, service, adapter}: SectionConstruct, title: string,
                           parameter: AutomatableParameterFieldAdapter<number>,
                           model: MutableObservableValue<number>, tooltip: string) => {
    const {editing, midiLearning} = service.project
    return (
        <div className="control">
            <h3>{title}</h3>
            <AutomationControl lifecycle={lifecycle}
                               editing={editing}
                               midiLearning={midiLearning}
                               tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                               parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle}
                                           editing={editing}
                                           parameter={parameter}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]} framed={true}/>
                </RelativeUnitValueDragging>
            </AutomationControl>
            <Checkbox lifecycle={lifecycle}
                      model={booleanModel(model)}
                      style={{fontSize: "10px"}}
                      appearance={{cursor: "pointer", tooltip}}>
                <Icon symbol={IconSymbol.Shutdown}/>
            </Checkbox>
        </div>
    )
}

// Icons only, spread over the control's width.
export const iconRadio = (lifecycle: Lifecycle, model: MutableObservableValue<number>,
                          elements: ReadonlyArray<RadioElement>, span: int, fontSize: string) => (
    <div className="control spread" style={{gridColumn: `span ${span}`}}>
        <RadioGroup lifecycle={lifecycle} model={model} className="spread" style={{fontSize}} elements={elements}/>
    </div>
)

export const display = (rows: [int, int], columns: [int, int], content: HTMLElement) => (
    <div className="display" style={{gridArea: `${rows[0]} / ${columns[0]} / ${rows[1]} / ${columns[1]}`}}>{content}</div>
)
