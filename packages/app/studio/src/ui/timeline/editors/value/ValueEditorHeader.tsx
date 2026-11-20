import css from "./ValueEditorHeader.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {createElement} from "@opendaw/lib-jsx"
import {ParameterValueEditing} from "@/ui/timeline/editors/value/ParameterValueEditing.ts"
import {Html, ModfierKeys} from "@opendaw/lib-dom"
import {NumberInput} from "@/ui/components/NumberInput"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "ValueEditorHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    context: ParameterValueEditing
}

export const ValueEditorHeader = ({lifecycle, service, context}: Construct) => {
    const {Cmd, Opt, Shift} = ModfierKeys.System
    const name: HTMLElement = <p/>
    const stepsInput: HTMLElement = <div className="input"/>
    const element: HTMLElement = (
        <div className={className}>
            <div className="help-section manual">
                <span><Icon symbol={IconSymbol.DoubleClick}/></span><span>create / delete</span>
                <span>{Cmd}<Icon symbol={IconSymbol.DoubleClick}/></span><span>node that holds (no ramp)</span>
                <span>{Shift}<Icon symbol={IconSymbol.Click}/></span><span>cut segment</span>
                <span>{Opt}<Icon symbol={IconSymbol.Drag}/></span><span>paint on empty space</span>
                <span>{Opt}{Cmd}<Icon symbol={IconSymbol.Drag}/></span><span>paint steps on empty space</span>
                <span>{Cmd}<Icon symbol={IconSymbol.Drag}/></span><span>copy nodes</span>
                <span>{Shift}<Icon symbol={IconSymbol.Drag}/></span><span>move nodes without value snap</span>
                <span>{Opt}<Icon symbol={IconSymbol.Drag}/></span><span>move nodes in time only</span>
                <span>Enter</span><span>type value or slope</span>
            </div>
            <div className="steps" title="Value steps (0 = continuous, 2 = on/off)">
                <span>Steps</span>
                {stepsInput}
            </div>
        </div>
    )
    const stepsLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(context.track.catchupAndSubscribe(optTrack => {
        stepsLifecycle.terminate()
        stepsInput.replaceChildren()
        optTrack.ifSome(track => stepsInput.appendChild(
            <NumberInput lifecycle={stepsLifecycle}
                         maxChars={3}
                         guard={{guard: value => value < 2 ? 0 : Math.round(value)}}
                         model={EditWrapper.forValue(service.project.editing, track.box.valueSteps)}/>))
    }))
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