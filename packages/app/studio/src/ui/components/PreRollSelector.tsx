import css from "./PreRollSelector.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {NumberInput} from "@/ui/components/NumberInput"

const className = Html.adoptStyleSheet(css, "PreRollSelector")

type Construct = {
    lifecycle: Lifecycle
    quarters: MutableObservableValue<number>
}

export const PreRollSelector = ({lifecycle, quarters}: Construct) => (
    <div className={className}>
        <div>Pre-roll:</div>
        <NumberInput lifecycle={lifecycle} model={quarters} maxChars={3}
                     guard={{guard: value => Math.max(0, Math.round(value))}}/>
        <div>quarter notes</div>
        <div className="note">Plays earlier, so held notes and echoes reach into the bounce.</div>
    </div>
)
