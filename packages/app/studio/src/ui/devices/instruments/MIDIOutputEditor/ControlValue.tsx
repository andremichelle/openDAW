import css from "./ControlValue.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {byte, clamp, EmptyExec, Lifecycle, Strings} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {AudioUnitTracks, AutomatableParameterFieldAdapter} from "@moises-ai/studio-adapters"
import {IconSymbol} from "@moises-ai/studio-enums"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {Project} from "@moises-ai/studio-core"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {DblClckTextInput} from "@/ui/wrapper/DblClckTextInput"
import {MIDIOutputParameterBox} from "@moises-ai/studio-boxes"
import {NumberInput} from "@/ui/components/NumberInput"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "ControlValue")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    tracks: AudioUnitTracks
    box: MIDIOutputParameterBox
    parameter: AutomatableParameterFieldAdapter<byte>
}

export const ControlValue = ({lifecycle, project, tracks, box, parameter}: Construct) => {
    const {editing, midiLearning} = project
    return (
        <div className={className}>
            <DblClckTextInput resolversFactory={() => {
                const resolvers = Promise.withResolvers<string>()
                resolvers.promise.then((value: string) =>
                    editing.modify(() => box.label.setValue(value)), EmptyExec)
                return resolvers
            }} provider={() => ({unit: "", value: box.label.getValue()})}>
                <span onInit={element => lifecycle.own(box.label
                    .catchupAndSubscribe(owner =>
                        element.textContent = Strings.fallback(owner.getValue(), "Unnamed")))}/>
            </DblClckTextInput>
            <span>#</span>
            <NumberInput lifecycle={lifecycle}
                         model={EditWrapper.forValue(editing, box.controller)}
                         guard={{guard: (value: number): byte => clamp(value, 0, 127)}}/>
            <AutomationControl lifecycle={lifecycle}
                               editing={editing}
                               midiLearning={midiLearning}
                               tracks={tracks}
                               parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle}
                                           editing={editing}
                                           parameter={parameter}>
                    <ParameterLabel lifecycle={lifecycle}
                                    parameter={parameter}
                                    framed/>
                </RelativeUnitValueDragging>
            </AutomationControl>
            <div/>
            <Button lifecycle={lifecycle}
                    onClick={() => editing.modify(() => parameter.field.box.delete())}>
                <Icon symbol={IconSymbol.Delete}/>
            </Button>
        </div>
    )
}