import css from "./TargetList.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {LfoModulatorBoxAdapter, ModulationBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"

const className = Html.adoptStyleSheet(css, "TargetList")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: LfoModulatorBoxAdapter
}

export const TargetList = ({lifecycle, service, modulator}: Construct): HTMLElement => {
    const {editing} = service.project
    const entries: HTMLElement = <div className="entries"/>
    const rows = lifecycle.own(new Terminator())
    const render = () => {
        rows.terminate()
        Html.empty(entries)
        modulator.assignments.forEach((assignment: ModulationBoxAdapter) => entries.append(
            <div className="entry">
                <span className="target">
                    {assignment.targetOwner.unwrapOrElse("")}
                    <span className="separator">&gt;</span>
                    {assignment.target.mapOr(parameter => parameter.name, "Unknown")}
                </span>
                <RelativeUnitValueDragging lifecycle={rows}
                                           editing={editing}
                                           parameter={assignment.namedParameter.depth}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={rows}
                                    parameter={assignment.namedParameter.depth}
                                    framed={true}/>
                </RelativeUnitValueDragging>
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
    return (
        <div className={className}>
            <div className="title">Targets</div>
            {entries}
        </div>
    )
}
