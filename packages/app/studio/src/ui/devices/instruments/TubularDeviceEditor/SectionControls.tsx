import {int, Lifecycle, MutableObservableValue, ObservableValue, Observer, Procedure} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter, TubularDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"

export type SectionConstruct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: TubularDeviceBoxAdapter
    selectTab: Procedure<int>
}

export const sectionKnob = ({lifecycle, service, adapter}: SectionConstruct,
                            parameter: AutomatableParameterFieldAdapter<number>, label?: string) => {
    const {editing, midiLearning} = service.project
    return ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter, label})
}

export type RadioElement = {value: number, tooltip?: string, element: HTMLElement | SVGSVGElement}

export const headerToggle = (lifecycle: Lifecycle, model: MutableObservableValue<number>, labels: ReadonlyArray<string>) => (
    <RadioGroup lifecycle={lifecycle}
                model={model}
                className="toggle"
                elements={labels.map((label, value) => ({value, element: <span>{label}</span>}))}/>
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

export const switchCheckbox = (lifecycle: Lifecycle, model: MutableObservableValue<number>, tooltip: string) => (
    <Checkbox lifecycle={lifecycle}
              model={booleanModel(model)}
              className="switch"
              appearance={{cursor: "pointer", tooltip}}>
        <Icon symbol={IconSymbol.Shutdown}/>
    </Checkbox>
)

export const radioCell = (lifecycle: Lifecycle, title: string, model: MutableObservableValue<number>,
                          elements: ReadonlyArray<string> | ReadonlyArray<RadioElement>, span = 1, fontSize = "8px") => (
    <div className="cell" style={{gridColumn: `span ${span}`}}>
        <h5>{title}</h5>
        <RadioGroup lifecycle={lifecycle}
                    model={model}
                    className="radios"
                    style={{fontSize}}
                    elements={elements.map((entry, value) =>
                        typeof entry === "string" ? {value, element: <span>{entry}</span>} : entry)}/>
    </div>
)
