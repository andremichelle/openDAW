import {Lifecycle, unitValue} from "@moises-ai/lib-std"
import {Knob} from "@/ui/components/Knob.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {createElement} from "@moises-ai/lib-jsx"
import {AutomatableParameterFieldAdapter, DeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {BoxEditing} from "@moises-ai/lib-box"
import {MIDILearning} from "@moises-ai/studio-core"

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    midiDevices: MIDILearning,
    adapter: DeviceBoxAdapter
    parameter: AutomatableParameterFieldAdapter
    anchor: unitValue
}

export const LabelKnob = ({lifecycle, editing, midiDevices, adapter, parameter, anchor}: Construct) => {
    return (
        <div style={{display: "contents"}}>
            <Knob lifecycle={lifecycle} value={parameter} anchor={anchor}/>
            <ParameterLabel lifecycle={lifecycle}
                            editing={editing}
                            midiLearning={midiDevices}
                            adapter={adapter}
                            parameter={parameter}/>
        </div>
    )
}