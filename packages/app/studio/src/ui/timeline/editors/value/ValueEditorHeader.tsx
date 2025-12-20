import css from "./ValueEditorHeader.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {createElement} from "@opendaw/lib-jsx"
import {ParameterValueEditing} from "@/ui/timeline/editors/value/ValueEditingContext.ts"
import {Html, ModfierKeys} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "ValueEditorHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    context: ParameterValueEditing
}

export const ValueEditorHeader = ({lifecycle, context}: Construct) => {
    const {Cmd, Opt, Shift} = ModfierKeys.System
    const name: HTMLElement = <p/>
    const element: HTMLElement = (
        <div className={className}>
            <p className="help-section manual">
                Double-click to create/delete value.<br/>
                {Opt} + click on segment to cut.<br/>
                {Cmd} + drag to paint events.<br/>
                Drag + {Cmd} to copy events.<br/>
                Optional hold {Shift} to disable value snapping or hold {Opt} to contrain movement to time.
            </p>
        </div>
    )
    lifecycle.own(context.catchupAndSubscribeValueAssignment(optAssignment => {
        if (optAssignment.isEmpty()) {
            name.textContent = "Unassigned"
        } else {
            const assignment = optAssignment.unwrap()
            name.textContent = `Name: "${assignment.adapter.name}"`
        }
    }))
    return element
}