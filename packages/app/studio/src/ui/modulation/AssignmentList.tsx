import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {LfoModulatorBoxAdapter, ModulationBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob.tsx"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: LfoModulatorBoxAdapter
}

export const AssignmentList = ({lifecycle, service, modulator}: Construct): HTMLElement => {
    const {editing} = service.project
    const list: HTMLElement = <div className="list"/>
    const entries = lifecycle.own(new Terminator())
    const render = () => {
        entries.terminate()
        Html.empty(list)
        const assignments = modulator.assignments
        if (assignments.length === 0) {
            list.append(<div className="empty">Right-click any control and choose Modulate</div>)
            return
        }
        assignments.forEach((assignment: ModulationBoxAdapter) => {
            const target = assignment.target
            list.append(
                <div className="entry">
                    <div className="target">
                        <span className="parameter">{target.mapOr(parameter => parameter.name, "Unknown")}</span>
                        <span className="path">{assignment.targetOwner.unwrapOrElse("")}</span>
                    </div>
                    <div className="depth">
                        <ParameterLabelKnob lifecycle={entries}
                                            editing={editing}
                                            parameter={assignment.namedParameter.depth}
                                            anchor={0.5}/>
                    </div>
                    <Button lifecycle={entries}
                            onClick={() => editing.modify(() => assignment.box.delete())}>
                        <Icon symbol={IconSymbol.Delete}/>
                    </Button>
                </div>
            )
        })
    }
    lifecycle.own(modulator.box.assignments.pointerHub.catchupAndSubscribe({
        onAdded: () => render(),
        onRemoved: () => render()
    }))
    render()
    return list
}
