import css from "./UnitDisplay.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {int, Lifecycle, ObservableValue, Procedure} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "UnitDisplay")

type Construct = {
    lifecycle: Lifecycle
    name: string
    value: ObservableValue<string>
    numChars?: int
    onInit?: Procedure<HTMLElement>
}

export const UnitDisplay = ({lifecycle, name, value, numChars, onInit}: Construct) => {
    return (
        <div className={className} style={{flex: `0 0 ${numChars ?? 2}ch`}} onInit={onInit}>
            <div onInit={
                element => lifecycle.own(value.catchupAndSubscribe(owner => element.textContent = owner.getValue()))
            }/>
            <div>{name}</div>
        </div>
    )
}