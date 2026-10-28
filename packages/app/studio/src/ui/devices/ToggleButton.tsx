import {Events, Html} from "@opendaw/lib-dom"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Exec, Lifecycle, ObservableValue} from "@opendaw/lib-std"
import css from "./ParameterToggleButton.sass?inline"

const className = Html.adoptStyleSheet(css, "ParameterToggleButton")
type Construct = {lifecycle: Lifecycle, active: ObservableValue<boolean>, onClick: Exec}

export const ToggleButton = ({lifecycle, active, onClick}: Construct, children: ReadonlyArray<JsxValue>) => (
    <div className={className} onInit={element => lifecycle.ownAll(
        active.catchupAndSubscribe(owner => element.classList.toggle("active", owner.getValue())),
        Events.subscribe(element, "click", onClick)
    )}>{children}</div>
)
