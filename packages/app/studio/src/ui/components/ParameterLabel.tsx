import css from "./ParameterLabel.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "ParameterLabel")

type Construct = {
    lifecycle: Lifecycle
    parameter: AutomatableParameterFieldAdapter
    classList?: ReadonlyArray<string>
    framed?: boolean
}

export const ParameterLabel = (
    {lifecycle, parameter, classList, framed}: Construct): HTMLLabelElement => (
    <label className={Html.buildClassList(className, framed && "framed", ...classList ?? [])}
           onInit={element => {
               const onValueChange = (adapter: AutomatableParameterFieldAdapter) => {
                   const printValue = adapter.stringMapping.x(
                       adapter.valueMapping.y(adapter.getControlledUnitValue()))
                   element.textContent = printValue.value
                   element.setAttribute("unit", printValue.unit)
               }
               lifecycle.own(parameter.subscribe(onValueChange))
               onValueChange(parameter)
           }}/>
)