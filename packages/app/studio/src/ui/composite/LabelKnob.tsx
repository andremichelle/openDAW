import {Lifecycle, unitValue} from "@moises-ai/lib-std"
import {Knob} from "@/ui/components/Knob.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {createElement} from "@moises-ai/lib-jsx"
import {AutomatableParameterFieldAdapter} from "@moises-ai/studio-adapters"

type Construct = {
    lifecycle: Lifecycle
    parameter: AutomatableParameterFieldAdapter
    anchor: unitValue
}

export const LabelKnob = ({lifecycle, parameter, anchor}: Construct) => {
    return (
        <div style={{display: "contents"}}>
            <Knob lifecycle={lifecycle} value={parameter} anchor={anchor}/>
            <ParameterLabel lifecycle={lifecycle}
                            parameter={parameter}/>
        </div>
    )
}
