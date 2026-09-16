import {Events, Html} from "@opendaw/lib-dom"
import css from "./TextInput.sass?inline"
import {int, isInstanceOf, Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {ClipboardPayload} from "./ClipboardPayload"
import {createElement} from "@opendaw/lib-jsx"

const defaultClassName = Html.adoptStyleSheet(css, "TextInput")

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableValue<string>
    className?: string
    maxChars?: int
}

export const TextInput = ({lifecycle, model, className, maxChars}: Construct) => {
    maxChars ??= 127
    const input: HTMLElement = (<div contentEditable="true" style={{width: "100%"}}/>)
    const element: HTMLElement = (
        <div className={Html.buildClassList(defaultClassName, className)}>
            {input}
        </div>
    )
    const update = () => input.textContent = model.getValue()
    lifecycle.ownAll(
        Events.subscribe(element, "focusin", (event: Event) => {
            if (!isInstanceOf(event.target, HTMLElement)) {return}
            Html.selectContent(event.target)
        }),
        Events.subscribe(element, "focusout", (event: Event) => {
            if (!isInstanceOf(event.target, HTMLElement)) {return}
            update()
            Html.unselectContent(event.target)
        }),
        Events.subscribe(element, "copy", (event: ClipboardEvent) => {
            event.preventDefault()
            event.clipboardData?.setData("application/json", ClipboardPayload.write("text", model.getValue()))
        }),
        Events.subscribe(element, "paste", (event: ClipboardEvent) => {
            ClipboardPayload.read(event.clipboardData?.getData("application/json"), "text").ifSome(value => {
                event.preventDefault()
                model.setValue(String(value))
            })
        }),
        Events.subscribe(element, "input", (event: Event) => {
            const target = event.target
            if (!isInstanceOf(target, HTMLElement)) {return}
            const newValue = target.textContent?.slice(0, maxChars) ?? ""
            model.setValue(newValue)
        })
    )
    update()
    return element
}