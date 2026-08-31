import css from "./TimeCodeInput.sass?inline"
import {
    checkIndex,
    int,
    isDefined,
    isInstanceOf,
    Lifecycle,
    MutableObservableValue,
    safeRead,
    tryCatch
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {Events, Html} from "@opendaw/lib-dom"
import {StudioPreferences} from "@opendaw/studio-core"

const defaultClassName = Html.adoptStyleSheet(css, "TimeCodeInput")

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableValue<ppqn>
    className?: string
    negativeWarning?: boolean
    signature?: [int, int]
    oneBased?: boolean
}

export const TimeCodeInput = ({lifecycle, model, className, negativeWarning, signature, oneBased}: Construct) => {
    const upper = signature?.at(0) ?? 4
    const lower = signature?.at(1) ?? 4
    const units = [
        {amount: PPQN.Bar, maxChars: 3},
        {amount: PPQN.Quarter, maxChars: 1},
        {amount: PPQN.SemiQuaver, maxChars: 1},
        {amount: 1, maxChars: 3}
    ]
    const subOffset = oneBased === true ? 1 : 0
    const barOffset = () => oneBased === true
        ? StudioPreferences.settings["time-display"]["count-bars-from-zero"] ? 0 : 1
        : 0
    const inputs: ReadonlyArray<HTMLElement> = units.map(({maxChars}) => (
        <div contentEditable="true" style={{width: `calc(0.5em + ${maxChars * 6 + 1}px)`}}/>
    ))
    const element: HTMLElement = (
        <div className={Html.buildClassList(defaultClassName, className)}>
            {inputs}
        </div>
    )
    let editing = false
    const updateDigits = (force: boolean = false) => {
        const value = model.getValue()
        const negative = value < 0
        element.classList.toggle("negative", negativeWarning === true && negative)
        // While a sub-field is focused, do not overwrite the user's in-progress text with an external model
        // change (e.g. the property-table writing the focus note's values back) — that jumps the field back to
        // the previous number (#369). Only this field's own edits (Arrow/Enter) force a refresh.
        if (editing && !force) {return}
        const {bars, beats, semiquavers, ticks} = PPQN.toParts(value, upper, lower)
        inputs[0].textContent = negative ? String(bars) : String(bars + barOffset()).padStart(3, "0")
        inputs[1].textContent = String(beats + subOffset)
        inputs[2].textContent = String(semiquavers + subOffset)
        inputs[3].textContent = String(ticks).padStart(3, "0")
    }
    if (oneBased === true) {
        lifecycle.own(StudioPreferences.subscribe(() => updateDigits(), "time-display", "count-bars-from-zero"))
    }
    lifecycle.ownAll(
        model.subscribe(() => updateDigits()),
        Events.subscribe(element, "focusin", (event: Event) => {
            if (!isInstanceOf(event.target, HTMLElement)) {return}
            editing = true
            Html.selectContent(event.target)
        }),
        Events.subscribe(element, "focusout", (event: FocusEvent) => {
            if (!isInstanceOf(event.target, HTMLElement)) {return}
            // focusout bubbles from every sub-field: moving between them is still editing, so only end
            // editing (and flush any deferred model change) once focus leaves the whole element (#369).
            if (isInstanceOf(event.relatedTarget, Node) && element.contains(event.relatedTarget)) {return}
            editing = false
            updateDigits()
            Html.unselectContent(event.target)
        }),
        Events.subscribe(element, "copy", (event: ClipboardEvent) => {
            event.preventDefault()
            event.clipboardData?.setData("application/json", JSON.stringify({
                app: "openDAW",
                content: "timecode",
                value: model.getValue()
            }))
        }),
        Events.subscribe(element, "paste", (event: ClipboardEvent) => {
            const data = event.clipboardData?.getData("application/json")
            if (isDefined(data)) {
                const {status, value: json} = tryCatch(() => JSON.parse(data))
                if (status === "failure") {return}
                if (safeRead(json, "app") === "openDAW" && safeRead(json, "content") === "timecode") {
                    event.preventDefault()
                    model.setValue(json.value ?? 0)
                    updateDigits(true) // reflect the paste while focused, else the parts stay stale
                }
            }
        }),
        Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {return}
            const target = event.target
            if (!isInstanceOf(target, HTMLElement)) {return}
            const index = checkIndex(inputs.indexOf(target), inputs)
            switch (event.code) {
                case "ArrowUp": {
                    event.preventDefault()
                    model.setValue(model.getValue() + units[index].amount)
                    updateDigits(true)
                    Html.selectContent(target)
                    break
                }
                case "ArrowDown": {
                    event.preventDefault()
                    model.setValue(model.getValue() - units[index].amount)
                    updateDigits(true)
                    Html.selectContent(target)
                    break
                }
                case "Enter": {
                    event.preventDefault()
                    const unit = parseInt(target.textContent ?? "") | 0
                    const prevValue = model.getValue()
                    const {bars, beats, semiquavers, ticks} = PPQN.toParts(prevValue, upper, lower)
                    const nextValue: int =
                        units[0].amount * (index === 0 ? prevValue >= 0 ? unit - barOffset() : unit : bars)
                        + units[1].amount * (index === 1 ? unit - subOffset : beats)
                        + units[2].amount * (index === 2 ? unit - subOffset : semiquavers)
                        + units[3].amount * (index === 3 ? unit : ticks)
                    if (prevValue === nextValue) {
                        updateDigits(true)
                    } else {
                        model.setValue(nextValue)
                        updateDigits(true)
                    }
                    Html.selectContent(target)
                    break
                }
                case "Digit1":
                case "Digit2":
                case "Digit3":
                case "Digit4":
                case "Digit5":
                case "Digit6":
                case "Digit7":
                case "Digit8":
                case "Digit9":
                case "Digit0":
                case "Tab":
                case "ArrowLeft":
                case "ArrowRight":
                case "Minus":
                case "Backspace": {
                    break // Allow
                }
                default: {
                    console.debug("ignore", event.code)
                    event.preventDefault()
                }
            }
        })
    )
    updateDigits()
    return element
}