import css from "./ParameterLabelKnob.sass?inline"
import {Editing, Lifecycle, unitValue, ValueGuide} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {LabelKnob} from "@/ui/composite/LabelKnob.tsx"
import {AutomatableParameterFieldAdapter} from "@moises-ai/studio-adapters"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "ParameterLabelKnob")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    parameter: AutomatableParameterFieldAdapter
    options?: ValueGuide.Options
    anchor?: unitValue
}

export const ParameterLabelKnob = ({
                                       lifecycle,
                                       editing,
                                       parameter,
                                       options,
                                       anchor
                                   }: Construct) => (
    <div className={className}>
        <RelativeUnitValueDragging lifecycle={lifecycle}
                                   editing={editing}
                                   parameter={parameter}
                                   supressValueFlyout={true}
                                   options={options}>
            <LabelKnob lifecycle={lifecycle}
                       parameter={parameter}
                       anchor={anchor ?? 0.0}/>
        </RelativeUnitValueDragging>
    </div>
)
