import css from "./TempoTrackBody.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, ValueMapping} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {ValueEditor} from "@/ui/timeline/editors/value/ValueEditor"
import {TempoValueContext} from "@/ui/timeline/tracks/primary/tempo/TempoValueContext"
import {TempoValueEventOwnerReader} from "@/ui/timeline/tracks/primary/tempo/TempoValueEventOwnerReader"

const className = Html.adoptStyleSheet(css, "TempoTrackBody")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoTrackBody = ({lifecycle, service}: Construct) => {
    const {project, timeline: {range, snapping}} = service
    return (
        <div className={className}>
            <ValueEditor lifecycle={lifecycle}
                         service={service}
                         range={range}
                         snapping={snapping}
                         context={new TempoValueContext(project.timelineBoxAdapter)}
                         mapping={ValueMapping.unipolar()}
                         reader={new TempoValueEventOwnerReader(project.timelineBoxAdapter)}/>
        </div>
    )
}