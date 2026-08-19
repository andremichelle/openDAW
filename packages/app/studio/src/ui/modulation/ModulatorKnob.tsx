import {Lifecycle, unitValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Column} from "@/ui/devices/Column.tsx"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob.tsx"
import {attachModulatorParameterContextMenu} from "@/ui/menu/automation.ts"
import {installControlSourceIndicator} from "@/ui/components/AutomationControl.tsx"
import {LKR} from "@/ui/devices/constants.ts"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    parameter: AutomatableParameterFieldAdapter
    anchor?: unitValue
}

export const ModulatorKnob = ({lifecycle, service, parameter, anchor}: Construct): HTMLElement => {
    const {editing, midiLearning} = service.project
    const column: HTMLElement = (
        <Column ems={LKR}>
            <h5>{parameter.name}</h5>
            <ParameterLabelKnob lifecycle={lifecycle} editing={editing} parameter={parameter} anchor={anchor}/>
        </Column>
    )
    installControlSourceIndicator(lifecycle, parameter, column, column)
    lifecycle.own(attachModulatorParameterContextMenu(editing, midiLearning, parameter, column))
    return column
}
