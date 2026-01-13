import css from "./ButtonCheckboxRadio.sass?inline"
import {Color, isDefined, Lifecycle, Procedure, ValueOrProvider} from "@moises-ai/lib-std"
import {createElement, JsxValue} from "@moises-ai/lib-jsx"
import {TextTooltip} from "@/ui/surface/TextTooltip.tsx"
import {CssUtils, Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "ButtonCheckboxRadio")

export type Appearance = {
    color?: Color
    activeColor?: Color
    framed?: boolean
    landscape?: boolean
    tooltip?: ValueOrProvider<string>
    cursor?: CssUtils.Cursor
}

type Construct = {
    lifecycle: Lifecycle
    dataClass: string
    style?: Partial<CSSStyleDeclaration>
    className?: string
    appearance?: Appearance
    onInit?: Procedure<HTMLElement>
}

export const ButtonCheckboxRadio = (
    {
        lifecycle, dataClass, style, className: externalClassName, appearance, onInit
    }: Construct,
    children: JsxValue) => {
    const wrapper: HTMLElement = (
        <div className={Html.buildClassList(className,
            appearance?.framed && "framed",
            appearance?.landscape && "landscape",
            externalClassName)}
             onInit={onInit}
             data-class={dataClass}
             onpointerdown={(event: PointerEvent) => {
                 self.getSelection()?.removeAllRanges()
                 event.preventDefault()
                 event.stopPropagation()
             }}>
            {children}
        </div>
    )

    if (appearance?.tooltip) {
        lifecycle.own(TextTooltip.simple(wrapper, () => {
            const {left, bottom} = wrapper.getBoundingClientRect()
            return {
                clientX: left,
                clientY: bottom + 8,
                text: appearance.tooltip ?? ""
            }
        }))
    }

    if (isDefined(appearance?.color)) {
        wrapper.style.setProperty("--color", appearance.color.toString())
    }
    if (isDefined(appearance?.activeColor)) {
        wrapper.style.setProperty("--color-active", appearance.activeColor.toString())
    }
    if (isDefined(style)) {
        Object.assign(wrapper.style, style)
    }
    return wrapper
}