import {assert, getOrProvide, isDefined, Lifecycle, MutableObservableValue, ValueOrProvider} from "@moises-ai/lib-std"
import {createElement, DomElement} from "@moises-ai/lib-jsx"
import {Appearance, ButtonCheckboxRadio} from "@/ui/components/ButtonCheckboxRadio.tsx"
import {TextTooltip} from "@/ui/surface/TextTooltip.tsx"
import {Html} from "@moises-ai/lib-dom"

type Construct<VALUE> = {
    lifecycle: Lifecycle
    model: MutableObservableValue<VALUE>
    elements: ReadonlyArray<Readonly<{
        value: VALUE,
        element: DomElement,
        tooltip?: ValueOrProvider<string>,
        className?: string
    }>>
    style?: Partial<CSSStyleDeclaration>
    className?: string
    appearance?: Appearance
}

export const RadioGroup = <T, >({lifecycle, model, elements, style, className, appearance}: Construct<T>) => {
    const name = Html.nextID()
    const map = new Map<T, HTMLInputElement>()
    const children: ReadonlyArray<[HTMLInputElement, HTMLLabelElement]> =
        elements.map(({value, element, tooltip, className}) => {
            const glue = Html.nextID()
            const input: HTMLInputElement = (
                <input type="radio"
                       id={glue}
                       name={name}
                       className={className}
                       checked={value === model.getValue()}
                       oninput={() => {
                           model.setValue(value)
                           input.checked = value === model.getValue()
                       }}/>
            )
            const label = <label className={className} htmlFor={glue}>{element}</label>
            if (isDefined(tooltip)) {
                lifecycle.own(TextTooltip.simple(label, () => {
                    const clientRect = label.getBoundingClientRect()
                    return {
                        clientX: (clientRect.left + clientRect.right) * 0.5,
                        clientY: clientRect.bottom + 8,
                        text: getOrProvide(tooltip)
                    }
                }))
            }
            assert(!map.has(value), `${value} is not a unique key`)
            map.set(value, input)
            return [input, label]
        })
    lifecycle.own(model.subscribe(owner => {
        const active = map.get(owner.getValue())
        if (isDefined(active)) {
            active.checked = true
        } else {
            children.forEach(([input]) => input.checked = false)
        }
    }))
    return (
        <ButtonCheckboxRadio lifecycle={lifecycle}
                             style={style}
                             appearance={appearance}
                             className={className}
                             dataClass="radio-group">{children}</ButtonCheckboxRadio>
    )
}