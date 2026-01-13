import {Lifecycle, MutableObservableValue, Procedure} from "@moises-ai/lib-std"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {Appearance, ButtonCheckboxRadio} from "@/ui/components/ButtonCheckboxRadio.tsx"
import {Html} from "@moises-ai/lib-dom"

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
            <label htmlFor={id} style={{cursor: appearance?.cursor ?? "auto"}}>{children}</label>
        </ButtonCheckboxRadio>
    )
}