import css from "./ChordTrack.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService.ts"
import {ChordTrackBody} from "@/ui/timeline/tracks/primary/chord/ChordTrackBody.tsx"
import {ChordTrackHeader} from "@/ui/timeline/tracks/primary/chord/ChordTrackHeader.tsx"

const className = Html.adoptStyleSheet(css, "ChordTrack")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ChordTrack = ({lifecycle, service}: Construct) => (
    <div className={className}>
        <ChordTrackHeader lifecycle={lifecycle}
                          editing={service.project.editing}
                          timelineBox={service.project.timelineBox}/>
        <div className="void"/>
        <ChordTrackBody lifecycle={lifecycle} service={service}/>
    </div>
)
