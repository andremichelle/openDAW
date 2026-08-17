import css from "./ModulationPanel.sass?inline"
import {Lifecycle, MutableObservableOption, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {LfoModulatorBoxAdapter, Modulators} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob.tsx"
import {ShapeDisplay} from "@/ui/modulation/ShapeDisplay.tsx"
import {AssignmentList} from "@/ui/modulation/AssignmentList.tsx"

const className = Html.adoptStyleSheet(css, "ModulationPanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ModulationPanel = ({lifecycle, service}: Construct) => {
    const {project} = service
    const {editing, rootBoxAdapter} = project
    const selected = new MutableObservableOption<LfoModulatorBoxAdapter>()
    const list: HTMLElement = <div className="list"/>
    const inspector: HTMLElement = <div className="column inspector"/>
    const assignments: HTMLElement = <div className="column assignments"/>
    const inspectorLifecycle = lifecycle.own(new Terminator())
    const renderInspector = () => {
        inspectorLifecycle.terminate()
        Html.empty(inspector)
        Html.empty(assignments)
        if (selected.isEmpty()) {
            inspector.append(<div className="placeholder">No modulator selected</div>)
            return
        }
        const modulator = selected.unwrap()
        const {shape, rate, phase, amount} = modulator.namedParameter
        inspector.append(
            <h5><span>{modulator.label}</span></h5>,
            <ShapeDisplay lifecycle={inspectorLifecycle} modulator={modulator}/>,
            <div className="knobs">
                <ParameterLabelKnob lifecycle={inspectorLifecycle} editing={editing} parameter={shape}/>
                <ParameterLabelKnob lifecycle={inspectorLifecycle} editing={editing} parameter={rate}/>
                <ParameterLabelKnob lifecycle={inspectorLifecycle} editing={editing} parameter={phase}/>
                <ParameterLabelKnob lifecycle={inspectorLifecycle} editing={editing} parameter={amount}/>
            </div>
        )
        assignments.append(
            <h5><span>Targets</span></h5>,
            <AssignmentList lifecycle={inspectorLifecycle} service={service} modulator={modulator}/>
        )
    }
    const select = (adapter: LfoModulatorBoxAdapter) => {
        selected.wrap(adapter)
        renderList()
        renderInspector()
    }
    const listLifecycle = lifecycle.own(new Terminator())
    const renderList = () => {
        listLifecycle.terminate()
        Html.empty(list)
        const adapters = rootBoxAdapter.modulators.adapters()
        if (adapters.length === 0) {
            list.append(<div className="empty">No modulators yet</div>)
        }
        adapters.forEach(adapter => {
            const isSelected = selected.mapOr(current => UUID.equals(current.uuid, adapter.uuid), false)
            const count: HTMLElement = <span className="count"/>
            listLifecycle.own(adapter.box.assignments.pointerHub.catchupAndSubscribe({
                onAdded: () => count.textContent = String(adapter.assignments.length),
                onRemoved: () => count.textContent = String(adapter.assignments.length)
            }))
            count.textContent = String(adapter.assignments.length)
            list.append(
                <div classList={Html.buildClassList("entry", isSelected && "selected")}
                     onclick={() => select(adapter)}>
                    <Icon symbol={IconSymbol.Waveform}/>
                    <span className="name">{adapter.label}</span>
                    {count}
                </div>
            )
        })
    }
    lifecycle.own(rootBoxAdapter.modulators.catchupAndSubscribe({
        onAdd: (adapter: LfoModulatorBoxAdapter) => {
            renderList()
            if (selected.isEmpty()) {select(adapter)}
        },
        onRemove: (adapter: LfoModulatorBoxAdapter) => {
            if (selected.mapOr(current => UUID.equals(current.uuid, adapter.uuid), false)) {selected.clear()}
            renderList()
            renderInspector()
        },
        onReorder: () => renderList()
    }))
    renderList()
    renderInspector()
    return (
        <div className={className}>
            <div className="column modulators">
                <h5>
                    <span>Modulators</span>
                    <span className="spacer"/>
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => Modulators.createLfo(project))}>
                        <Icon symbol={IconSymbol.Add}/>
                    </Button>
                </h5>
                {list}
            </div>
            {inspector}
            {assignments}
        </div>
    )
}
