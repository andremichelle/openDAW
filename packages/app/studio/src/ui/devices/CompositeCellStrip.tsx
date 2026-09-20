import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {CompositeCell} from "@opendaw/studio-adapters"
import {Project} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {Knob} from "@/ui/components/Knob.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs.ts"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {CompositeRows} from "@/ui/devices/CompositeRows"

type Construct = {
    lifecycle: Lifecycle
    project: Project
    cell: CompositeCell
    noun: string
}

export const CompositeCellStrip = ({lifecycle, project, cell, noun}: Construct) => {
    const {editing, midiLearning} = project
    const {gain, pan, mute, solo} = cell.namedParameter
    const tracks = cell.audioUnitBoxAdapter().tracks
    const muteValue = new DefaultObservableValue(false)
    const soloValue = new DefaultObservableValue(false)
    lifecycle.ownAll(
        CompositeRows.connectBoolean(muteValue, EditWrapper.forAutomatableParameter(editing, mute)),
        CompositeRows.connectBoolean(soloValue, EditWrapper.forAutomatableParameter(editing, solo))
    )
    return (
        <Frag>
            <div className="channel-mix" data-swallow-click="">
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
            <div className="channel-isolation" data-swallow-click="">
                <Checkbox lifecycle={lifecycle} model={muteValue}
                          appearance={{activeColor: Colors.orange, framed: true, tooltip: `Mute ${noun}`}}>
                    <Icon symbol={IconSymbol.Mute}/>
                </Checkbox>
                <Checkbox lifecycle={lifecycle} model={soloValue}
                          appearance={{activeColor: Colors.yellow, framed: true, tooltip: `Solo ${noun}`}}>
                    <Icon symbol={IconSymbol.Solo}/>
                </Checkbox>
            </div>
        </Frag>
    )
}
