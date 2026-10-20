import css from "./BounceOptionsSelector.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AudioBounce} from "@opendaw/studio-core"
import {IconSymbol} from "@opendaw/studio-enums"
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

export const BounceOptionsSelector = ({lifecycle, tap, loop, tail, merge, canMerge}: Construct) => {
    const description: HTMLElement = (<div className="note"/>)
    lifecycle.own(tap.catchupAndSubscribe(owner =>
        description.textContent = Taps.find(entry => entry.value === owner.getValue())?.description ?? ""))
    const tailRow: ReadonlyArray<HTMLElement> = [
        <div>Tail:</div>,
        <Checkbox lifecycle={lifecycle} model={tail}>
            <Icon symbol={IconSymbol.Checkbox}/> {`Until silent, at most ${AudioBounce.MaxTailSeconds} seconds`}
        </Checkbox>
    ]
    const mergeRow: ReadonlyArray<HTMLElement> = [
        <div>Merge:</div>,
        <Checkbox lifecycle={lifecycle} model={merge}>
            <Icon symbol={IconSymbol.Checkbox}/> One region per instrument
        </Checkbox>
    ]
    lifecycle.own(loop.catchupAndSubscribe(owner => {
        tailRow.forEach(element => element.classList.toggle("hidden", owner.getValue()))
        mergeRow.forEach(element => element.classList.toggle("hidden", owner.getValue() || !canMerge))
    }))
    return (
        <div className={className}>
            <div>Signal:</div>
            <RadioGroup lifecycle={lifecycle}
                        model={tap}
                        elements={Taps.map(({value, label}) => ({value, element: <span>{label}</span>}))}/>
            {description}
            <div>Loop:</div>
            <Checkbox lifecycle={lifecycle} model={loop}>
                <Icon symbol={IconSymbol.Checkbox}/> One pass, looped like the region
            </Checkbox>
            {tailRow}
            {mergeRow}
        </div>
    )
}
