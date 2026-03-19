import css from "./AutomatableControl.sass?inline"
import {ControlSource, Editing, Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {attachParameterContextMenu} from "@/ui/menu/automation.ts"
import {AutomatableParameterFieldAdapter, DeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Html} from "@moises-ai/lib-dom"
import {MIDILearning} from "@moises-ai/studio-core"

const className = Html.adoptStyleSheet(css, "AutomatableControl")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    midiLearning: MIDILearning
    adapter: DeviceBoxAdapter
    parameter: AutomatableParameterFieldAdapter
}

export const AutomatableControl = (
    {lifecycle, editing, midiLearning, adapter, parameter}: Construct): HTMLLabelElement => (
    <div className={className}
         onInit={element => {
             lifecycle.ownAll(
                 attachParameterContextMenu(editing, midiLearning,
                     adapter.deviceHost().audioUnitBoxAdapter().tracks, parameter, element),
                 parameter.catchupAndSubscribeControlSources({
                     onControlSourceAdd: (source: ControlSource) => element.classList.add(source),
                     onControlSourceRemove: (source: ControlSource) => element.classList.remove(source)
                 })
             )
         }}/>)