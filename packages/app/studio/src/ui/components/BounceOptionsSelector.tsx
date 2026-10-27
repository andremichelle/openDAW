import css from "./BounceOptionsSelector.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AudioBounce} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "BounceOptionsSelector")

const Taps: ReadonlyArray<{ value: AudioBounce.Tap, label: string, description: string }> = [
    {value: "pre-fx", label: "Pre FX", description: "The instrument only, without the audio effects."},
    {value: "pre-fader", label: "Pre Fader", description: "Instrument and audio effects, before volume and panning."},
    {value: "post-fader", label: "Post Fader", description: "Instrument and audio effects, after volume and panning."}
]

type Construct = {
    lifecycle: Lifecycle
    tap: MutableObservableValue<AudioBounce.Tap>
    loop: MutableObservableValue<boolean>
    tail: MutableObservableValue<boolean>
    merge: MutableObservableValue<boolean>
    canMerge: boolean
}

const Toggle = ({lifecycle, model, text}: { lifecycle: Lifecycle, model: MutableObservableValue<boolean>, text: string }) => (
    <div className="option">
        <Checkbox lifecycle={lifecycle} model={model} appearance={{framed: true, color: Colors.black}}>
            <Icon symbol={IconSymbol.Checkbox}/>
        </Checkbox>
        <span onclick={() => model.setValue(!model.getValue())}>{text}</span>
    </div>
)

export const BounceOptionsSelector = ({lifecycle, tap, loop, tail, merge, canMerge}: Construct) => {
    const description: HTMLElement = (<div className="note"/>)
    lifecycle.own(tap.catchupAndSubscribe(owner =>
        description.textContent = Taps.find(entry => entry.value === owner.getValue())?.description ?? ""))
    const tailRow: ReadonlyArray<HTMLElement> = [
        <div>Tail:</div>,
        <Toggle lifecycle={lifecycle} model={tail} text={`Until silent, at most ${AudioBounce.MaxTailSeconds} seconds`}/>
    ]
    const mergeRow: ReadonlyArray<HTMLElement> = [
        <div>Merge:</div>,
        <Toggle lifecycle={lifecycle} model={merge} text="One region per instrument"/>
    ]
    lifecycle.own(loop.catchupAndSubscribe(owner => {
        tailRow.forEach(element => element.classList.toggle("disabled", owner.getValue()))
        mergeRow.forEach(element => {
            element.classList.toggle("hidden", !canMerge)
            element.classList.toggle("disabled", owner.getValue())
        })
    }))
    return (
        <div className={className}>
            <div>Signal:</div>
            <RadioGroup lifecycle={lifecycle}
                        model={tap}
                        elements={Taps.map(({value, label}) => ({value, element: <span>{label}</span>}))}/>
            {description}
            <div>Loop:</div>
            <Toggle lifecycle={lifecycle} model={loop} text="One pass, looped like the region"/>
            {tailRow}
            {mergeRow}
        </div>
    )
}
