import {Lifecycle, Procedure} from "@moises-ai/lib-std"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {Appearance, ButtonCheckboxRadio} from "@/ui/components/ButtonCheckboxRadio"
import {Html} from "@moises-ai/lib-dom"

export type ButtonParameters = {
    lifecycle: Lifecycle
    onClick: Procedure<MouseEvent>
    style?: Partial<CSSStyleDeclaration>
    className?: string
    appearance?: Appearance
}

export const Button = ({lifecycle, onClick, style, className, appearance}: ButtonParameters, children: JsxValue) => {
    const id = Html.nextID()
    const input: HTMLInputElement = <input type="button" id={id} onclick={onClick}/>
    return (
        <ButtonCheckboxRadio lifecycle={lifecycle}
                             style={style}
                             className={className}
                             appearance={appearance}
                             dataClass="button">
            {input}
            <label htmlFor={id}>{children}</label>
        </ButtonCheckboxRadio>
    )
}