import {Editing, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AutomatableParameterFieldAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {MIDILearning} from "@opendaw/studio-core"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"

export type ControlContext = {
    lifecycle: Lifecycle
    editing: Editing
    midiLearning: MIDILearning
    deviceHost: DeviceHost
}

export const createParameterInput = ({lifecycle, editing, midiLearning, deviceHost}: ControlContext,
                                     parameter: AutomatableParameterFieldAdapter): JsxValue => (
    <AutomationControl lifecycle={lifecycle}
                       editing={editing}
                       midiLearning={midiLearning}
                       tracks={deviceHost.audioUnitBoxAdapter().tracks}
                       parameter={parameter}>
        <RelativeUnitValueDragging lifecycle={lifecycle}
                                   editing={editing}
                                   parameter={parameter}>
            <ParameterLabel lifecycle={lifecycle}
                            parameter={parameter}
                            framed/>
        </RelativeUnitValueDragging>
    </AutomationControl>
)

export const createParameterRow = (context: ControlContext, parameter: AutomatableParameterFieldAdapter,
                                   name?: string, second?: boolean): ReadonlyArray<JsxValue> => [
    <div className={Html.buildClassList("name", second && "second")}>{name ?? parameter.name}</div>,
    createParameterInput(context, parameter)
]

export const createParameterStack = (context: ControlContext, group: string, heading: string,
                                     upper: AutomatableParameterFieldAdapter,
                                     lower?: AutomatableParameterFieldAdapter): JsxValue => (
    <div className={`parameter-stack ${group}`}>
        <div className="label">{heading}</div>
        {createParameterRow(context, upper)}
        {isDefined(lower) ? createParameterRow(context, lower) : null}
    </div>
)
