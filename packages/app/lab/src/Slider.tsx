import css from "./Slider.sass?inline"
import {Events, Html} from "@moises-ai/lib-dom"
import {Lifecycle, Parameter} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"

const className = Html.adoptStyleSheet(css, "Slider")

type Construct = {
    lifecycle: Lifecycle
    parameter: Parameter
}

export const Slider = ({lifecycle, parameter}: Construct) => {
    return (
        <input type="range" className={className} min="0" max="1" step="any" onInit={element => {
            lifecycle.ownAll(
                parameter.catchupAndSubscribe(() => element.value = parameter.getUnitValue().toString()),
                Events.subscribe(element, "input", () => parameter.setUnitValue(element.valueAsNumber))
            )
        }}/>
    )
}