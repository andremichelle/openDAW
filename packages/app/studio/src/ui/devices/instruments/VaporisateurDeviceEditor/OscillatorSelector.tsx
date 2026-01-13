import css from "./OscillatorSelector.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {int, Lifecycle, MutableObservableValue} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"

const className = Html.adoptStyleSheet(css, "OscillatorSelector")

type Construct = {
    lifecycle: Lifecycle
    oscIndex: MutableObservableValue<int>
}

export const OscillatorSelector = ({lifecycle, oscIndex}: Construct) => {
    const labels = ["A", "B"]
    return (
        <div className={className}>
            {(() => {
                const elements: ReadonlyArray<HTMLSpanElement> = labels.map((label, index) => (
                    <span onclick={() => oscIndex.setValue(index)}>{label}</span>
                ))
                lifecycle.own(oscIndex.catchupAndSubscribe(owner =>
                    elements.forEach((element, index) =>
                        element.classList.toggle("active", index === owner.getValue()))))
                return elements
            })()}
        </div>
    )
}