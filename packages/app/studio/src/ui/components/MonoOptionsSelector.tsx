import css from "./MonoOptionsSelector.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AudioMonoConversion} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "MonoOptionsSelector")

const Modes: ReadonlyArray<{ value: AudioMonoConversion.Mode, label: string, description: string }> = [
    {value: "sum", label: "Sum", description: "Adds the channels at full level, the result can be louder."},
    {value: "equal-power", label: "Power", description: "Adds the channels at -3 dB to keep the loudness."}
]

type Construct = {
    lifecycle: Lifecycle
    mode: MutableObservableValue<AudioMonoConversion.Mode>
    keepOriginal: MutableObservableValue<boolean>
}

export const MonoOptionsSelector = ({lifecycle, mode, keepOriginal}: Construct) => {
    const description: HTMLElement = (<div className="note"/>)
    const deletion: HTMLElement = (<div className="note"/>)
    lifecycle.ownAll(
        mode.catchupAndSubscribe(owner =>
            description.textContent = Modes.find(entry => entry.value === owner.getValue())?.description ?? ""),
        keepOriginal.catchupAndSubscribe(owner => deletion.textContent = owner.getValue()
            ? "The original sample stays in storage."
            : "The original sample will be deleted from storage.")
    )
    return (
        <div className={className}>
            <div>Mode:</div>
            <RadioGroup lifecycle={lifecycle}
                        model={mode}
                        elements={Modes.map(({value, label}) => ({value, element: <span>{label}</span>}))}
                        appearance={{framed: true}}/>
            {description}
            <div className="spaced">Original:</div>
            <div className="option spaced">
                <Checkbox lifecycle={lifecycle} model={keepOriginal} appearance={{framed: true, color: Colors.black}}>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
                <span onclick={() => keepOriginal.setValue(!keepOriginal.getValue())}>Keep original sample</span>
            </div>
            {deletion}
        </div>
    )
}
