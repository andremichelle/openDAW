import css from "./FloatingTextInput.sass?inline"
import {isDefined, Point} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "TextInput")

type Construct = {
    resolvers?: PromiseWithResolvers<string>
    position?: Point
    value?: boolean | number | string
    unit?: string
    numeric?: boolean
}

export const FloatingTextInput = ({resolvers, position, value, unit, numeric}: Construct) => {
    const focusElement = document.activeElement as HTMLElement
    const inputField: HTMLInputElement = (<input type="text" value={isDefined(value) ? String(value) : ""}/>)
    requestAnimationFrame(() => {
        inputField.select()
        inputField.focus()
    })
    if (isDefined(resolvers)) {
        const {reject, resolve} = resolvers
        const remove = () => {
            inputField.onblur = null
            inputField.onkeydown = null
            element.remove()
            focusElement?.focus()
        }
        inputField.onblur = () => {
            remove()
            reject("cancel")
        }
        inputField.onkeydown = (event: KeyboardEvent) => {
            if (event.key.toLowerCase() === "enter") {
                const value = numeric ? inputField.value.replace(",", ".") : inputField.value
                remove()
                resolve(value)
            }
        }
    }
    const element: HTMLElement = (
        <div className={className} unit={unit}
             style={isDefined(position) ? {
                 position: "absolute",
                 transform: `translate(${position.x}px, ${position.y}px)`
             } : {}}>
            {inputField}
        </div>
    )
    return element
}