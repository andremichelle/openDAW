import css from "./SearchInput.sass?inline"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"

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
               placeholder={placeholder}
               oninput={(event) => {
                   if (event.target instanceof HTMLInputElement) {
                       model.setValue(event.target.value)
                   }
               }}
               onConnect={element => {
                   element.focus()
                   lifecycle.own(model.subscribe(owner => element.value = owner.getValue()))
               }}/>
    )
    const element: HTMLElement = (
        <div className={className} style={style}>
            <Icon symbol={IconSymbol.Search}/>
            {input}
        </div>
    )
    element.focus = () => {
        input.blur()
        input.focus()
    }
    return element
}