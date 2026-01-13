import css from "./MarkerTrack.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {MarkerTrackBody} from "@/ui/timeline/tracks/primary/marker/MarkerTrackBody.tsx"
import {MarkerTrackHeader} from "@/ui/timeline/tracks/primary/marker/MarkerTrackHeader.tsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "MarkerTrack")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MarkerTrack = ({lifecycle, service}: Construct) => {
    return (
        <div className={className}>
            <MarkerTrackHeader lifecycle={lifecycle}
                               editing={service.project.editing}
                               timelineBox={service.project.timelineBox}/>
            <div className="void"/>
            <MarkerTrackBody lifecycle={lifecycle}
                             service={service}/>
        </div>
    )
}