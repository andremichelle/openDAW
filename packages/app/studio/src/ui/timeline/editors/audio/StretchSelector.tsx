import css from "./StretchSelector.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {DefaultObservableValue, Lifecycle, panic} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {IconSymbol} from "@moises-ai/studio-enums"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Icon} from "@/ui/components/Icon"
import {AudioContentModifier, Project} from "@moises-ai/studio-core"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {TimeStretchEditor} from "@/ui/timeline/editors/audio/TimeStretchEditor"

const className = Html.adoptStyleSheet(css, "StretchSelector")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    reader: AudioEventOwnerReader
}

export const StretchSelector = ({lifecycle, project, reader}: Construct) => {
    const enum PlayModeEnum {NoWarp, Pitch, TimeStretch}

    const {editing} = project
    const {audioContent} = reader
    const toPlayModeEnum = (): PlayModeEnum => {
        if (audioContent.isPlayModeNoStretch) {return PlayModeEnum.NoWarp}
        if (audioContent.asPlayModePitchStretch.nonEmpty()) {return PlayModeEnum.Pitch}
        if (audioContent.asPlayModeTimeStretch.nonEmpty()) {return PlayModeEnum.TimeStretch}
        return panic("Unknown PlayMode")
    }
    const playModeEnumValue = new DefaultObservableValue(toPlayModeEnum())
    lifecycle.ownAll(
        playModeEnumValue.subscribe(async owner => {
            const playModeEnum = owner.getValue()
            if (playModeEnum === PlayModeEnum.NoWarp) {
                const exec = await AudioContentModifier.toNotStretched([audioContent])
                editing.modify(exec)
            } else if (playModeEnum === PlayModeEnum.Pitch) {
                const exec = await AudioContentModifier.toPitchStretch([audioContent])
                editing.modify(exec)
            } else if (playModeEnum === PlayModeEnum.TimeStretch) {
                const exec = await AudioContentModifier.toTimeStretch([audioContent])
                editing.modify(exec)
            }
        }),
        audioContent.box.playMode.subscribe(() => playModeEnumValue.setValue(toPlayModeEnum()))
    )
    return (
        <div className={className}>
            <RadioGroup lifecycle={lifecycle}
                        model={playModeEnumValue}
                        elements={[
                            {
                                value: PlayModeEnum.NoWarp,
                                element: (<span>No</span>),
                                tooltip: "No Warp"
                            },
                            {
                                value: PlayModeEnum.Pitch,
                                element: (<Icon symbol={IconSymbol.TapeReel}/>),
                                tooltip: "Pitch Stretch"
                            },
                            {
                                value: PlayModeEnum.TimeStretch,
                                element: (<Icon symbol={IconSymbol.Time}/>),
                                tooltip: "Time Stretch"
                            }
                        ]}/>
            <hr/>
            <TimeStretchEditor lifecycle={lifecycle}
                               project={project}
                               reader={reader}/>
        </div>
    )
}