import {Html} from "@opendaw/lib-dom"
import css from "./SearchInput.sass?inline"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"

const className = Html.adoptStyleSheet(css, "SearchInput")

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableValue<string>
    placeholder?: string
    style?: Partial<CSSStyleDeclaration>
}

export const SearchInput = ({lifecycle, model, placeholder, style}: Construct) => {
    const input: HTMLInputElement = (
        <input type="search"
               value={model.getValue()}
               className={className}
               placeholder={placeholder}
               style={style} oninput={(event) => {
            if (event.target instanceof HTMLInputElement) {
                model.setValue(event.target.value)
            }
        }}/>
    )
    lifecycle.own(model.subscribe(owner => input.value = owner.getValue()))
    return input
}