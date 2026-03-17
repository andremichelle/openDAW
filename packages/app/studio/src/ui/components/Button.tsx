import {Lifecycle, Procedure} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Appearance, ButtonCheckboxRadio} from "@/ui/components/ButtonCheckboxRadio"
import {Html} from "@opendaw/lib-dom"

export type ButtonParameters = {
    lifecycle: Lifecycle
    onClick: Procedure<MouseEvent>
    onInit?: Procedure<HTMLElement>
    style?: Partial<CSSStyleDeclaration>
    className?: string
    appearance?: Appearance
}

export const Button = ({
                           lifecycle,
                           onClick,
                           onInit,
                           style,
                           className,
                           appearance
                       }: ButtonParameters, children: JsxValue) => {
    const id = Html.nextID()
    const input: HTMLInputElement = <input type="button" id={id} onclick={onClick} onInit={onInit}/>
    return (
        <ButtonCheckboxRadio lifecycle={lifecycle}
                             style={style}
                             className={className}
                             appearance={appearance}
                             dataClass="button">
            {input}
            <label htmlFor={id} style={{cursor: appearance?.cursor ?? "auto"}}>{children}</label>
        </ButtonCheckboxRadio>
    )
}