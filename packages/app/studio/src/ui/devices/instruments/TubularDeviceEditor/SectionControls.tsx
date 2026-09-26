import {int, Lifecycle, MutableObservableValue, Procedure} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter, TubularDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {RadioGroup} from "@/ui/components/RadioGroup"

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
