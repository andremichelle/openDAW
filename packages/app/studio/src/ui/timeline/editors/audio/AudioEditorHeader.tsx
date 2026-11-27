import css from "./AudioEditorHeader.sass?inline"
import {clamp, Lifecycle, StringMapping} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Project} from "@opendaw/studio-core"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {StretchSelector} from "@/ui/timeline/editors/audio/StretchSelector"
import {NumberInput} from "@/ui/components/NumberInput"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {DigitDragging} from "@/ui/components/DigitDragging"

const className = Html.adoptStyleSheet(css, "AudioEditorHeader")

const MinGain = -60.0
const MaxGain = 24.0

type Construct = {
    lifecycle: Lifecycle
    project: Project
    reader: AudioEventOwnerReader
}

export const AudioEditorHeader = ({lifecycle, project, reader}: Construct) => {
    const {editing} = project
    const dragging = {active: false}
    const drag: DigitDragging.Hooks = {
        begin: () => {
            editing.mark()
            dragging.active = true
        },
        end: () => {
            dragging.active = false
            editing.mark()
        }
    }
    const markUnlessDragging = () => !dragging.active
    return (
        <div className={className}>
            <span className="label top">Stretch Mode:</span>
            <StretchSelector lifecycle={lifecycle}
                             project={project}
                             reader={reader}/>
            <span className="label">Waveform Offset:</span>
            <div className="waveform-offset">
                <NumberInput lifecycle={lifecycle}
                             mapper={StringMapping.numeric({fractionDigits: 3, unit: "sec"})}
                             className="input"
                             maxChars={5}
                             step={0.005}
                             drag={drag}
                             model={EditWrapper.forValue(editing, reader.audioContent.waveformOffset, markUnlessDragging)}/>
                <span>sec</span>
            </div>
            <span className="label">Gain:</span>
            <div className="gain">
                <NumberInput lifecycle={lifecycle}
                             mapper={StringMapping.numeric({fractionDigits: 1, unit: "dB"})}
                             className="input"
                             maxChars={5}
                             step={0.5}
                             guard={{guard: value => clamp(value, MinGain, MaxGain)}}
                             drag={drag}
                             model={EditWrapper.forValue(editing, reader.audioContent.gain, markUnlessDragging)}/>
                <span>dB</span>
            </div>
        </div>
    )
}