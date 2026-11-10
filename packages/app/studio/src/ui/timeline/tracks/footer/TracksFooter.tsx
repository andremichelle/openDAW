import css from "./TracksFooter.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {TimelineRangeSlider} from "@/ui/timeline/TimelineRangeSlider.tsx"
import {createElement} from "@opendaw/lib-jsx"
import {TracksFooterHeader} from "@/ui/timeline/tracks/footer/TracksFooterHeader.tsx"
import {Html} from "@opendaw/lib-dom"
import {ClipsScroller} from "@/ui/timeline/tracks/audio-unit/clips/ClipsScroller"

const className = Html.adoptStyleSheet(css, "TracksFooter")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TracksFooter = ({lifecycle, service}: Construct) => {
    return (
        <div className={className}>
            <TracksFooterHeader/>
            <ClipsScroller lifecycle={lifecycle} service={service}/>
            <TimelineRangeSlider lifecycle={lifecycle}
                                 range={service.timeline.range}
                                 className="clips-aware"/>
        </div>
    )
}