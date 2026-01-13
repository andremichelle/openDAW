import css from "./TempoTrack.sass?inline"
import {Lifecycle, MutableObservableValue} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {TempoTrackBody} from "@/ui/timeline/tracks/primary/tempo/TempoTrackBody.tsx"
import {TempoTrackHeader} from "@/ui/timeline/tracks/primary/tempo/TempoTrackHeader.tsx"
import {Html} from "@moises-ai/lib-dom"
import {bpm} from "@moises-ai/lib-dsp"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "TempoTrack")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoTrack = ({lifecycle, service}: Construct) => {
    const {project: {editing, timelineBox}} = service
    const bpmRange: [MutableObservableValue<bpm>, MutableObservableValue<bpm>] = [
        EditWrapper.forValue(editing, timelineBox.tempoTrack.minBpm),
        EditWrapper.forValue(editing, timelineBox.tempoTrack.maxBpm)
    ]
    return (
        <div className={className}>
            <TempoTrackHeader lifecycle={lifecycle} service={service} bpmRange={bpmRange}/>
            <div className="void"/>
            <TempoTrackBody lifecycle={lifecycle} service={service} bpmRange={bpmRange}/>
        </div>
    )
}