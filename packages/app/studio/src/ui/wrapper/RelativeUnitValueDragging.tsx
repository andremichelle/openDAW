import {
    Editing,
    EmptyExec,
    Lifecycle,
    Nullable,
    Option,
    panic,
    Parameter,
    Strings,
    Terminable,
    unitValue,
    ValueGuide
} from "@opendaw/lib-std"
import {createElement, Group, JsxValue} from "@opendaw/lib-jsx"
import {ValueDragging} from "@/ui/hooks/dragging"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {ValueTooltip} from "@/ui/surface/ValueTooltip.tsx"
import {Surface} from "../surface/Surface"
import {Events} from "@opendaw/lib-dom"
import {Runtime} from "@opendaw/lib-runtime"
import {Preferences} from "@opendaw/studio-core"

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    parameter: Parameter
    supressValueFlyout?: boolean
    options?: ValueGuide.Options
}

const lookForSolidElement = (element: Element): Element => {
    let elem: Nullable<Element> = element
    while (getComputedStyle(elem).display === "contents") {
        elem = elem.firstElementChild
        if (elem === null) {
            return panic("Illegal State. No solid element found.")
        }
    }
    return elem
}

export const RelativeUnitValueDragging = ({
                                              lifecycle, editing, parameter, supressValueFlyout, options
                                          }: Construct, children: JsxValue) => {
    const element: HTMLElement = (<Group>{children}</Group>)
    lifecycle.ownAll(
        Events.subscribeDblDwn(element, () => {
            const solid: Element = lookForSolidElement(element)
            const rect = solid.getBoundingClientRect()
            const printValue = parameter.getPrintValue()
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then(value => {
                const withUnit = Strings.endsWithDigit(value) ? `${value}${printValue.unit}` : value
                editing.modify(() => parameter.setPrintValue(withUnit))
                editing.mark()
            }, EmptyExec)
            Surface.get(element).flyout.appendChild(
                <FloatingTextInput position={{x: rect.left, y: rect.top + (rect.height >> 1)}}
                                   value={printValue.value}
                                   unit={printValue.unit}
                                   numeric
                                   resolvers={resolvers}/>
            )
        }),
        supressValueFlyout === true ? Terminable.Empty : ValueTooltip.default(element, () => {
            const clientRect = lookForSolidElement(element).getBoundingClientRect()
            return ({
                clientX: clientRect.left + 8,
                clientY: clientRect.top + clientRect.height + 8,
                ...parameter.getPrintValue()
            })
        }),
        ValueDragging.installUnitValueRelativeDragging((_event: PointerEvent) => Option.wrap({
            start: (): unitValue => {
                element.classList.add("modifying")
                return parameter.getUnitValue()
            },
            modify: (value: unitValue) => editing.modify(() => parameter.setUnitValue(value), false),
            cancel: (prevValue: unitValue) => editing.modify(() => parameter.setUnitValue(prevValue), false),
            finalise: (_prevValue: unitValue, _newValue: unitValue): void => editing.mark(),
            finally: (): void => element.classList.remove("modifying")
        }), element, options),
        Events.subscribe(element, "wheel", event => {
            if (!Preferences.values["modifying-controls-wheel"]) {return}
            const value = parameter.getUnitValue() - Math.sign(event.deltaY) * 0.01
            editing.modify(() => parameter.setUnitValue(value), false)
            Runtime.debounce(() => editing.mark())
        }, {passive: true})
    )
    return element
}