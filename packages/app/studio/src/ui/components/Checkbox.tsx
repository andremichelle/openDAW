import {Lifecycle, MutableObservableValue, Procedure} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Appearance, ButtonCheckboxRadio} from "@/ui/components/ButtonCheckboxRadio.tsx"
import {Html} from "@opendaw/lib-dom"

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableValue<boolean>
    style?: Partial<CSSStyleDeclaration>
    className?: string
    appearance?: Appearance
    onInit?: Procedure<HTMLElement>
}

export const Checkbox = ({lifecycle, model, style, className, appearance, onInit}: Construct, children: JsxValue) => {
    const id = Html.nextID()
    const input: HTMLInputElement = (
        <input type="checkbox"
               id={id}
               oninput={() => {
                   model.setValue(input.checked)
                   input.checked = model.getValue()
               }}
               checked={model.getValue()}/>
    )
    lifecycle.own(model.subscribe(model => input.checked = model.getValue()))
    return (
        <ButtonCheckboxRadio lifecycle={lifecycle}
                             style={style}
                             className={className}
                             appearance={appearance}
                             dataClass="checkbox"
                             onInit={onInit}>
            {input}
            <label htmlFor={id}
                   style={{cursor: appearance?.cursor ?? "auto"}}
                   onclick={(event: MouseEvent) => {
                       // Firefox does not forward a label click with a modifier key to its input
                       if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {return}
                       event.preventDefault()
                       model.setValue(!model.getValue())
                       input.checked = model.getValue()
                   }}>{children}</label>
        </ButtonCheckboxRadio>
    )
}