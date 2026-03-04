import css from "./ParameterLabel.sass?inline"
import {ControlSource, Lifecycle, Terminable, Editing} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {attachParameterContextMenu} from "@/ui/menu/automation.ts"
import {AutomatableParameterFieldAdapter, DeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Html} from "@opendaw/lib-dom"
import {MIDILearning} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ParameterLabel")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    midiLearning: MIDILearning
    adapter: DeviceBoxAdapter
    parameter: AutomatableParameterFieldAdapter
    classList?: ReadonlyArray<string>
    framed?: boolean
    standalone?: boolean
}

export const ParameterLabel = (
    {
        lifecycle, editing, midiLearning, adapter, parameter,
        classList, framed, standalone
    }: Construct): HTMLLabelElement => (
    <label className={Html.buildClassList(className, framed && "framed", ...classList ?? [])}
           onInit={element => {
               const onValueChange = (adapter: AutomatableParameterFieldAdapter) => {
                   const printValue = adapter.stringMapping.x(
                       adapter.valueMapping.y(adapter.getControlledUnitValue()))
                   element.textContent = printValue.value
                   element.setAttribute("unit", printValue.unit)
               }
               lifecycle.ownAll(
                   standalone === true
                       ? attachParameterContextMenu(editing, midiLearning,
                           adapter.deviceHost().audioUnitBoxAdapter().tracks, parameter, element)
                       : Terminable.Empty,
                   parameter.catchupAndSubscribeControlSources({
                       onControlSourceAdd: (source: ControlSource) => element.classList.add(source),
                       onControlSourceRemove: (source: ControlSource) => element.classList.remove(source)
                   }),
                   parameter.subscribe(onValueChange)
               )
               onValueChange(parameter)
           }}/>
)