import css from "./TargetList.sass?inline"
import {Lifecycle, ObservableValue, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {LfoModulatorBoxAdapter, ModulationBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {installScrollbars} from "@/ui/components/Scrollbars.tsx"

const className = Html.adoptStyleSheet(css, "TargetList")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: LfoModulatorBoxAdapter
}

export const TargetList = ({lifecycle, service, modulator}: Construct): HTMLElement => {
    const {editing} = service.project
    const entries: HTMLElement = <div className="entries"
                                       onConnect={host => lifecycle.own(installScrollbars(host))}/>
    const element: HTMLElement = <div className={className}>{entries}</div>
    const rows = lifecycle.own(new Terminator())
    const render = () => {
        rows.terminate()
        Html.empty(entries)
        modulator.assignments.forEach((assignment: ModulationBoxAdapter) => entries.append(
            <div className="entry"
                 onInit={element => rows.own(assignment.box.enabled
                     .catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                         element.classList.toggle("disabled", !owner.getValue())))}>
                <span className="target">
                    <span className="owner">{assignment.targetOwner.unwrapOrElse("")}</span>
                    <span className="parameter">
                        {assignment.target.mapOr(parameter => parameter.name, "Unknown")}
                    </span>
                </span>
                <RelativeUnitValueDragging lifecycle={rows}
                                           editing={editing}
                                           parameter={assignment.namedParameter.depth}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={rows}
                                    parameter={assignment.namedParameter.depth}
                                    framed={true}/>
                </RelativeUnitValueDragging>
                <Icon symbol={IconSymbol.Shutdown} className="toggle" onInit={element =>
                    rows.own(Events.subscribe(element, "click", () =>
                        editing.modify(() => assignment.box.enabled.toggle())))}/>
                <Button lifecycle={rows} onClick={() => editing.modify(() => assignment.box.delete())}>
                    <Icon symbol={IconSymbol.Delete}/>
                </Button>
            </div>
        ))
    }
    lifecycle.own(modulator.box.assignments.pointerHub.catchupAndSubscribe({
        onAdded: () => render(),
        onRemoved: () => render()
    }))
    render()
    return element
}
