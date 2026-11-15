import css from "./ModulatorLabel.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {attachModulatorParameterContextMenu} from "@/ui/menu/automation.ts"
import {installControlSourceIndicator} from "@/ui/components/AutomationControl.tsx"

const className = Html.adoptStyleSheet(css, "ModulatorLabel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    parameter: AutomatableParameterFieldAdapter
}

export const ModulatorLabel = ({lifecycle, service, parameter}: Construct): HTMLElement => {
    const {editing, midiLearning} = service.project
    const label: HTMLElement = (
        <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]} framed={true}/>
    )
    const element: HTMLElement = (
        <div className={className}>
            <h3>{parameter.name}</h3>
            <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={parameter} supressValueFlyout={true}>
                {label}
            </RelativeUnitValueDragging>
        </div>
    )
    installControlSourceIndicator(lifecycle, parameter, element, label)
    lifecycle.own(attachModulatorParameterContextMenu(editing, midiLearning, parameter, label))
    return element
}
