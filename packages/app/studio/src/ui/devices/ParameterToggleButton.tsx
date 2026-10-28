import {Editing, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {ToggleButton} from "./ToggleButton"

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    parameter: AutomatableParameterFieldAdapter<boolean>
}

// TODO Create/Remove automation and midi learning

export const ParameterToggleButton = ({lifecycle, editing, parameter}: Construct) => (
    <ToggleButton lifecycle={lifecycle} active={parameter}
                  onClick={() => editing.modify(() => parameter.setValue(!parameter.getValue()))}>
        {parameter.name}
    </ToggleButton>
)