import css from "./AudioFormatSelector.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {clamp, isDefined, Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {NumberInput} from "@/ui/components/NumberInput"
import {DropDown} from "@/ui/composite/DropDown"
import {AudioFormats} from "@/audio/AudioFormats"

const className = Html.adoptStyleSheet(css, "AudioFormatSelector")

type Construct = {
    lifecycle: Lifecycle
    formats: ReadonlyArray<AudioFormats.Format>
    model: MutableObservableValue<AudioFormats.Format>
}

export const AudioFormatSelector = ({lifecycle, formats, model}: Construct) => {
    const descriptions: ReadonlyArray<HTMLElement> = formats.map(format => (<p>{format.description}</p>))
    const panels: ReadonlyArray<HTMLElement> = formats.map(format => (
        <div className={Html.buildClassList("fields", format.columns === 2 && "two-columns")}>
            {format.fields.map(field => renderField(lifecycle, field))}
        </div>
    ))
    const ffmpeg: HTMLElement = (<span className="ffmpeg">Requires FFmpeg (30MB, downloaded once)</span>)
    const update = () => {
        const format = model.getValue()
        formats.forEach((candidate, index) => {
            descriptions[index].classList.toggle("inactive", candidate !== format)
            panels[index].classList.toggle("inactive", candidate !== format)
        })
        ffmpeg.classList.toggle("hidden", !format.requiresFFmpeg)
    }
    lifecycle.own(model.subscribe(update))
    update()
    return (
        <div className={className}>
            <div className="format">
                <span>Format</span>
                {renderMenu(lifecycle, model, formats.map(format => ({value: format, label: format.label})), "12em")}
                {ffmpeg}
                <div className="descriptions">{descriptions}</div>
            </div>
            <div className="options">
                <h5>Options</h5>
                <div className="panels">{panels}</div>
            </div>
        </div>
    )
}

const renderField = (lifecycle: Lifecycle, field: AudioFormats.Field) => {
    const control = field.type === "number"
        ? renderNumber(lifecycle, field)
        : field.type === "menu"
            ? renderMenu<number | string | boolean>(lifecycle, field.model, field.choices, "8em")
            : (
                <RadioGroup lifecycle={lifecycle}
                            model={field.model}
                            elements={field.choices.map(({value, label}) => ({value, element: <span>{label}</span>}))}/>
            )
    const label: HTMLElement = (<span className="label">{field.label}</span>)
    const cell: HTMLElement = (<div className="control">{control}</div>)
    if (isDefined(field.visible)) {
        const {visible} = field
        const apply = () => [label, cell].forEach(element => element.classList.toggle("hidden", !visible.getValue()))
        lifecycle.own(visible.subscribe(apply))
        apply()
    }
    return [label, cell]
}

const renderMenu = <V, >(lifecycle: Lifecycle,
                         model: MutableObservableValue<V>,
                         choices: ReadonlyArray<AudioFormats.Choice<V>>,
                         width: string) => (
    <DropDown lifecycle={lifecycle}
              owner={model}
              provider={() => choices.map(({value}) => value)}
              mapping={value => choices.find(choice => choice.value === value)?.label ?? ""}
              width={width}/>
)

const renderNumber = (lifecycle: Lifecycle, {model, min, max, minLabel, maxLabel}: AudioFormats.NumberField) => (
    <div className="number">
        <NumberInput lifecycle={lifecycle} model={model} maxChars={2}
                     guard={{guard: value => clamp(Math.round(value), min, max)}}/>
        <span>{`${min} ${minLabel} to ${max} ${maxLabel}`}</span>
    </div>
)
