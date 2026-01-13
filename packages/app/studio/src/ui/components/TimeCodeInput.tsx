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
} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {ppqn, PPQN} from "@moises-ai/lib-dsp"
import {Events, Html} from "@moises-ai/lib-dom"

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
    const unitOffset = oneBased === true ? 1 : 0
    const inputs: ReadonlyArray<HTMLElement> = units.map(({maxChars}) => (
        <div contentEditable="true" style={{width: `calc(0.5em + ${maxChars * 6 + 1}px)`}}/>
    ))
    const element: HTMLElement = (
        <div className={Html.buildClassList(defaultClassName, className)}>
            {inputs}
        </div>
    )
    const updateDigits = () => {
        const value = model.getValue()
        const negative = value < 0
        element.classList.toggle("negative", negativeWarning === true && negative)
        const {bars, beats, semiquavers, ticks} = PPQN.toParts(value, upper, lower)
        inputs[0].textContent = negative ? String(bars) : String(bars + unitOffset).padStart(3, "0")
        inputs[1].textContent = String(beats + unitOffset)
        inputs[2].textContent = String(semiquavers + unitOffset)
        inputs[3].textContent = String(ticks).padStart(3, "0")
    }
    lifecycle.ownAll(
        model.subscribe(updateDigits),
        Events.subscribe(element, "focusin", (event: Event) => {
            if (!isInstanceOf(event.target, HTMLElement)) {return}
            Html.selectContent(event.target)
        }),
        Events.subscribe(element, "focusout", (event: Event) => {
            if (!isInstanceOf(event.target, HTMLElement)) {return}
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
                    Html.selectContent(target)
                    break
                }
                case "ArrowDown": {
                    event.preventDefault()
                    model.setValue(model.getValue() - units[index].amount)
                    Html.selectContent(target)
                    break
                }
                case "Enter": {
                    event.preventDefault()
                    const unit = parseInt(target.textContent ?? "") | 0
                    const prevValue = model.getValue()
                    const {bars, beats, semiquavers, ticks} = PPQN.toParts(prevValue, upper, lower)
                    const nextValue: int =
                        units[0].amount * (index === 0 ? prevValue >= 0 ? unit - unitOffset : unit : bars)
                        + units[1].amount * (index === 1 ? unit - unitOffset : beats)
                        + units[2].amount * (index === 2 ? unit - unitOffset : semiquavers)
                        + units[3].amount * (index === 3 ? unit : ticks)
                    if (prevValue === nextValue) {
                        updateDigits()
                    } else {
                        model.setValue(nextValue)
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