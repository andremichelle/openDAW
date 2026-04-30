import {AutomatableParameterFieldAdapter, DeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Column} from "@/ui/devices/Column.tsx"
import {createElement} from "@opendaw/lib-jsx"
import {LKR} from "@/ui/devices/constants.ts"
import {ParameterLabelKnob} from "@/ui/devices/ParameterLabelKnob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {Color, Editing, TerminableOwner, ValueGuide} from "@opendaw/lib-std"
import {PrimitiveValues} from "@opendaw/lib-box"
import {MIDILearning} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"

type Creation<T extends PrimitiveValues> = {
    lifecycle: TerminableOwner
    editing: Editing
    midiLearning: MIDILearning
    adapter: DeviceBoxAdapter
    parameter: AutomatableParameterFieldAdapter<T>
    options?: ValueGuide.Options
    anchor?: number
    color?: Color
    style?: Partial<CSSStyleDeclaration>
    disableAutomation?: boolean
    label?: string
}

export namespace ControlBuilder {
    export const createKnob = <T extends PrimitiveValues, >
    ({
         lifecycle,
         editing,
         midiLearning,
         adapter,
         parameter,
         options,
         anchor,
         color,
         style,
         disableAutomation,
         label
     }: Creation<T>) => {
        const tracks = adapter.deviceHost().audioUnitBoxAdapter().tracks
        return (
            <AutomationControl lifecycle={lifecycle}
                               editing={editing}
                               midiLearning={midiLearning}
                               tracks={tracks}
                               parameter={parameter}
                               disableAutomation={disableAutomation}>
                <Column ems={LKR} color={color ?? Colors.cream} style={style}>
                    <h5>{label ?? parameter.name}</h5>
                    <ParameterLabelKnob lifecycle={lifecycle}
                                        editing={editing}
                                        parameter={parameter}
                                        options={options}
                                        anchor={anchor}/>
                </Column>
            </AutomationControl>
        )
    }
}
