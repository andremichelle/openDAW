import css from "./ParameterToggleButton.sass?inline"
import {Events, Html} from "@moises-ai/lib-dom"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {AutomatableParameterFieldAdapter} from "@moises-ai/studio-adapters"
import {BoxEditing} from "@moises-ai/lib-box"

const className = Html.adoptStyleSheet(css, "ParameterToggleButton")

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    parameter: AutomatableParameterFieldAdapter<boolean>
}

// TODO Create/Remove automation and midi learning

export const ParameterToggleButton = ({lifecycle, editing, parameter}: Construct) => (
    <div className={className} onInit={element => {
        lifecycle.ownAll(
            parameter.catchupAndSubscribe(owner =>
                element.classList.toggle("active", owner.getValue())),
            Events.subscribe(element, "click", () =>
                editing.modify(() => parameter.setValue(!parameter.getValue())))
        )
    }}>{parameter.name}</div>
)