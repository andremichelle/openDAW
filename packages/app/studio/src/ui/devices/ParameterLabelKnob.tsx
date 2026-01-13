import css from "./ParameterLabelKnob.sass?inline"
import {Lifecycle, unitValue, ValueGuide} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {LabelKnob} from "@/ui/composite/LabelKnob.tsx"
import {AutomatableParameterFieldAdapter, DeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {BoxEditing} from "@moises-ai/lib-box"
import {attachParameterContextMenu} from "@/ui/menu/automation.ts"
import {Html} from "@moises-ai/lib-dom"
import {MIDILearning} from "@moises-ai/studio-core"

const className = Html.adoptStyleSheet(css, "ParameterLabelKnob")

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    midiLearning: MIDILearning
    adapter: DeviceBoxAdapter
    parameter: AutomatableParameterFieldAdapter
    options?: ValueGuide.Options
    anchor?: unitValue
}

export const ParameterLabelKnob = ({
                                       lifecycle,
                                       editing,
                                       midiLearning,
                                       adapter,
                                       parameter,
                                       options,
                                       anchor
                                   }: Construct) => {
    const element: HTMLElement = (
        <div className={className}>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}
                                       supressValueFlyout={true}
                                       options={options}>
                <LabelKnob lifecycle={lifecycle}
                           editing={editing}
                           midiDevices={midiLearning}
                           adapter={adapter}
                           parameter={parameter}
                           anchor={anchor ?? 0.0}/>
            </RelativeUnitValueDragging>
        </div>
    )
    lifecycle.own(
        attachParameterContextMenu(editing, midiLearning,
            adapter.deviceHost().audioUnitBoxAdapter().tracks, parameter, element))
    return element
}