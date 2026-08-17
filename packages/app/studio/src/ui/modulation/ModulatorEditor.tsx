import css from "./ModulatorEditor.sass?inline"
import {Errors, Lifecycle, ObservableValue, panic, Terminator} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {IconSymbol} from "@opendaw/studio-enums"
import {LfoModulatorBoxAdapter, ModulationBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob.tsx"
import {Column} from "@/ui/devices/Column.tsx"
import {LKR} from "@/ui/devices/constants.ts"
import {Surface} from "@/ui/surface/Surface.tsx"

const className = Html.adoptStyleSheet(css, "ModulatorEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    modulator: LfoModulatorBoxAdapter
}

export const ModulatorEditor = ({lifecycle, service, modulator}: Construct, controls: JsxValue) => {
    const {editing} = service.project
    const labelField = modulator.box.label
    const title: HTMLElement = (
        <h1 onInit={element => lifecycle.ownAll(
            labelField.catchupAndSubscribe(owner => element.textContent = owner.getValue()),
            Events.subscribeDblDwn(element, async event => {
                const {status, error, value} = await Promises.tryCatch(
                    Surface.get(element).requestFloatingTextInput(event, labelField.getValue()))
                if (status === "rejected") {
                    if (!Errors.isAbort(error)) {return panic(error)}
                } else {
                    editing.modify(() => labelField.setValue(value))
                }
            })
        )}/>
    )
    const targets: HTMLElement = <div className="targets"/>
    const targetsLifecycle = lifecycle.own(new Terminator())
    const renderTargets = () => {
        targetsLifecycle.terminate()
        Html.empty(targets)
        modulator.assignments.forEach((assignment: ModulationBoxAdapter) => targets.append(
            <div className="entry">
                <div className="target">
                    <span className="parameter">{assignment.target.mapOr(parameter => parameter.name, "Unknown")}</span>
                    <span className="path">{assignment.targetOwner.unwrapOrElse("")}</span>
                </div>
                <Column ems={LKR}>
                    <h5>Depth</h5>
                    <ParameterLabelKnob lifecycle={targetsLifecycle}
                                        editing={editing}
                                        parameter={assignment.namedParameter.depth}
                                        anchor={0.5}/>
                </Column>
                <Button lifecycle={targetsLifecycle}
                        onClick={() => editing.modify(() => assignment.box.delete())}>
                    <Icon symbol={IconSymbol.Delete}/>
                </Button>
            </div>
        ))
    }
    lifecycle.own(modulator.box.assignments.pointerHub.catchupAndSubscribe({
        onAdded: () => renderTargets(),
        onRemoved: () => renderTargets()
    }))
    renderTargets()
    return (
        <div className={className}
             onInit={element => lifecycle.own(modulator.box.enabled
                 .catchupAndSubscribe((owner: ObservableValue<boolean>) =>
                     element.classList.toggle("disabled", !owner.getValue())))}>
            <header>
                <Icon symbol={IconSymbol.Waveform} className="icon"/>
                {title}
                <Icon symbol={IconSymbol.Shutdown} className="toggle" onInit={element =>
                    lifecycle.own(Events.subscribe(element, "click", () =>
                        editing.modify(() => modulator.box.enabled.toggle())))}/>
                <Button lifecycle={lifecycle} onClick={() => editing.modify(() => modulator.box.delete())}>
                    <Icon symbol={IconSymbol.Delete}/>
                </Button>
            </header>
            <div className="body">{controls}</div>
            {targets}
        </div>
    )
}
