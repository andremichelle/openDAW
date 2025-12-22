import css from "./UnitDisplay.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {int, Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "UnitDisplay")

type Construct = {
    lifecycle: Lifecycle
    name: string
    value: ObservableValue<string>
    numChars?: int
}

export const UnitDisplay = ({lifecycle, name, value, numChars}: Construct) => {
    return (
        <div className={className} style={{flex: `0 0 ${numChars ?? 2}ch`}}>
            <div onInit={
                element => lifecycle.own(value.catchupAndSubscribe(owner => element.textContent = owner.getValue()))
            }/>
            <div>{name}</div>
        </div>
    )
}