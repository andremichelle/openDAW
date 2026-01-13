import css from "./TimelineNavigation.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {LoopAreaEditor} from "@/ui/timeline/LoopAreaEditor.tsx"
import {TimeAxis} from "@/ui/timeline/TimeAxis.tsx"
import {createElement} from "@moises-ai/lib-jsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "TimelineNavigation")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimelineNavigation = ({lifecycle, service}: Construct) => {
    const {range, snapping} = service.timeline
    const {editing, timelineBox} = service.project
    return (
        <div className={className}>
            <LoopAreaEditor lifecycle={lifecycle}
                            range={range}
                            snapping={snapping}
                            editing={editing}
                            loopArea={timelineBox.loopArea}/>
            <TimeAxis lifecycle={lifecycle} service={service}
                      snapping={snapping}
                      range={range}/>
        </div>
    )
}