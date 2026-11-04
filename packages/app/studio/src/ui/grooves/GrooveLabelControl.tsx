import {Editing, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    parameter: AutomatableParameterFieldAdapter<number>
}

// The devices' label control (a name above a framed value you drag), without automation: grooves have none
export const GrooveLabelControl = ({lifecycle, editing, parameter}: Construct): HTMLElement => (
    <div className="control">
        <h3>{parameter.name}</h3>
        <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={parameter} supressValueFlyout={true}>
            <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]} framed={true}/>
        </RelativeUnitValueDragging>
    </div>
)
