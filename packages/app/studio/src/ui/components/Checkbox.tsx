import {isDefined, Lifecycle, MutableObservableValue, ObservableValue, Procedure} from "@opendaw/lib-std"
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
    disabled?: ObservableValue<boolean>
}

export const Checkbox = ({lifecycle, model, style, className, appearance, onInit, disabled}: Construct, children: JsxValue) => {
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
    const wrapper = (
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
    if (isDefined(disabled)) {
        lifecycle.own(disabled.catchupAndSubscribe(owner => wrapper.classList.toggle("disabled", owner.getValue())))
    }
    return wrapper
}