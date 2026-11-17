import {isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AutomatableParameterFieldAdapter, CompositeCell} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Knob} from "@/ui/components/Knob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs.ts"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {ExclusiveSolo} from "@/ui/wrapper/ExclusiveSolo"
import {SendButton} from "@/ui/devices/SendButton"

type Construct = {
    lifecycle: Lifecycle
    project: Project
    cell: CompositeCell
    noun: string
    send?: AutomatableParameterFieldAdapter<boolean>
}

export const CompositeCellStrip = ({lifecycle, project, cell, noun, send}: Construct) => {
    const {editing, midiLearning} = project
    const {gain, pan, mute} = cell.namedParameter
    const tracks = cell.audioUnitBoxAdapter().tracks
    const exclusiveSolo = ExclusiveSolo.forCell(editing, cell)
    return (
        <Frag>
            <div className="channel-mix">
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={gain} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={gain} options={SnapCommonDecibel}>
                        <Knob lifecycle={lifecycle} value={gain} anchor={0.0} color={Colors.yellow}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
                <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                   tracks={tracks} parameter={pan} offset={2}>
                    <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing}
                                               parameter={pan} options={SnapCenter}>
                        <Knob lifecycle={lifecycle} value={pan} anchor={0.5} color={Colors.green}/>
                    </RelativeUnitValueDragging>
                </AutomationControl>
            </div>
            <div className="channel-isolation">
                {isDefined(send) ? (
                    <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                       tracks={tracks} parameter={send} offset={2}>
                        <SendButton lifecycle={lifecycle} editing={editing} parameter={send}/>
                    </AutomationControl>
                ) : null}
                <Checkbox lifecycle={lifecycle} model={EditWrapper.forAutomatableParameter(editing, mute)}
                          appearance={{activeColor: Colors.orange, framed: true, tooltip: `Mute ${noun}`}}>
                    <Icon symbol={IconSymbol.Mute}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={exclusiveSolo.model} onInit={exclusiveSolo.onInit}
                          appearance={{activeColor: Colors.yellow, framed: true, tooltip: `Solo ${noun}`}}>
                    <Icon symbol={IconSymbol.Solo}/>
                </Checkbox>
            </div>
        </Frag>
    )
}
