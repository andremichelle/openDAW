import css from "./AudioEditorHeader.sass?inline"
import {Lifecycle, StringMapping} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"
import {Project} from "@moises-ai/studio-core"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {StretchSelector} from "@/ui/timeline/editors/audio/StretchSelector"
import {NumberInput} from "@/ui/components/NumberInput"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "AudioEditorHeader")

type Construct = {
    lifecycle: Lifecycle
    project: Project
    reader: AudioEventOwnerReader
}

export const AudioEditorHeader = ({lifecycle, project, reader}: Construct) => {
    const {editing} = project
    return (
        <div className={className}>
            <span className="label">Stretch Mode:</span>
            <StretchSelector lifecycle={lifecycle}
                             project={project}
                             reader={reader}/>
            <span className="label">Waveform Offset:</span>
            <div className="waveform-offset">
                <NumberInput lifecycle={lifecycle}
                             mapper={StringMapping.numeric({fractionDigits: 3, unit: "sec"})}
                             className="input"
                             maxChars={5}
                             step={0.001}
                             model={EditWrapper.forValue(editing, reader.audioContent.waveformOffset)}/>
                <span>sec</span>
            </div>
        </div>
    )
}