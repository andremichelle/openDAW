import css from "./TargetList.sass?inline"
import {Lifecycle, ObservableValue, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {ModulationBoxAdapter, ModulatorBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {attachModulatorParameterContextMenu} from "@/ui/menu/automation.ts"
import {installControlSourceIndicator} from "@/ui/components/AutomationControl.tsx"
import {installScrollbars} from "@/ui/components/Scrollbars.tsx"

const className = Html.adoptStyleSheet(css, "TargetList")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: ModulatorBoxAdapter
}

export const TargetList = ({lifecycle, service, modulator}: Construct): HTMLElement => {
    const {editing, midiLearning, userEditingManager} = service.project
    const entries: HTMLElement = <div className="entries"
                                       onConnect={host => lifecycle.own(installScrollbars(host, {autoHide: false}))}/>
    const element: HTMLElement = <div className={className}>{entries}</div>
    const rows = lifecycle.own(new Terminator())
    const render = () => {
        rows.terminate()
        Html.empty(entries)
        if (modulator.assignments.length === 0) {
            entries.append(<div className="placeholder">
                Right-click any device control and choose Modulate
            </div>)
            return
        }
        modulator.assignments.forEach((assignment: ModulationBoxAdapter) => {
            const {depth} = assignment.namedParameter
            const depthLabel: HTMLElement = (<ParameterLabel lifecycle={rows} parameter={depth} framed={true}/>)
            rows.own(attachModulatorParameterContextMenu(editing, midiLearning, depth, depthLabel))
            // The label clips its own overflow, so the ring hangs off the scrolling container instead.
            installControlSourceIndicator(rows, depth, entries, depthLabel, 2)
            entries.append(<div className="entry"
                 onInit={element => rows.own(assignment.box.enabled
                     .catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                         element.classList.toggle("disabled", !owner.getValue())))}>
                <span className="target">
                    <span className="owner" onInit={element => rows.own(Events.subscribe(element, "click", () =>
                        assignment.targetAudioUnit.ifSome(unit =>
                            userEditingManager.audioUnit.edit(unit.box.editing))))}>
                        {assignment.targetOwner.unwrapOrElse("")}
                    </span>
                    <span className="parameter">
                        {assignment.target.mapOr(parameter => parameter.name, "Unknown")}
                    </span>
                </span>
                <RelativeUnitValueDragging lifecycle={rows}
                                           editing={editing}
                                           parameter={depth}
                                           supressValueFlyout={true}>
                    {depthLabel}
                </RelativeUnitValueDragging>
                <Icon symbol={IconSymbol.Shutdown} className="toggle" onInit={element =>
                    rows.own(Events.subscribe(element, "click", () =>
                        editing.modify(() => assignment.box.enabled.toggle())))}/>
                <Button lifecycle={rows} onClick={() => editing.modify(() => assignment.box.delete())}>
                    <Icon symbol={IconSymbol.Delete}/>
                </Button>
            </div>)
        })
    }
    lifecycle.own(modulator.box.assignments.pointerHub.catchupAndSubscribe({
        onAdded: () => render(),
        onRemoved: () => render()
    }))
    render()
    return element
}
