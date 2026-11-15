import css from "./Slider.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {isDefined, Lifecycle, MutableObservableValue, ValueGuard, ValueMapping} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"

const defaultClassName = Html.adoptStyleSheet(css, "Slider")

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableValue<number>
    mapping: ValueMapping<number>
    guard?: ValueGuard<number>
    className?: string
}

export const Slider = ({lifecycle, model, mapping, guard, className}: Construct) => {
    const input: HTMLInputElement = (
        <input type="range" min="0" max="1" step="any" className={Html.buildClassList(defaultClassName, className)}/>
    )
    const update = () => input.valueAsNumber = mapping.x(model.getValue())
    input.oninput = () => {
        const value = mapping.y(input.valueAsNumber)
        model.setValue(isDefined(guard) ? guard.guard(value) : value)
        update()
    }
    lifecycle.own(model.subscribe(update))
    update()
    return input
}
