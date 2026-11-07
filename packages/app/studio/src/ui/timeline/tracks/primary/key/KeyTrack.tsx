import css from "./KeyTrack.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService.ts"
import {KeyTrackBody} from "@/ui/timeline/tracks/primary/key/KeyTrackBody.tsx"
import {KeyTrackHeader} from "@/ui/timeline/tracks/primary/key/KeyTrackHeader.tsx"

const className = Html.adoptStyleSheet(css, "KeyTrack")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const KeyTrack = ({lifecycle, service}: Construct) => (
    <div className={className}>
        <KeyTrackHeader lifecycle={lifecycle}
                        editing={service.project.editing}
                        timelineBox={service.project.timelineBox}/>
        <div className="void"/>
        <KeyTrackBody lifecycle={lifecycle} service={service}/>
    </div>
)
