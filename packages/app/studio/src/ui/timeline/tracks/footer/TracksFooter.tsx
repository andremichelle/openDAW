import css from "./TracksFooter.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {TimelineRangeSlider} from "@/ui/timeline/TimelineRangeSlider.tsx"
import {createElement} from "@opendaw/lib-jsx"
import {TracksFooterHeader} from "@/ui/timeline/tracks/footer/TracksFooterHeader.tsx"
import {Html} from "@opendaw/lib-dom"
import {Orientation, Scroller} from "@/ui/components/Scroller.tsx"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {ClipWidth} from "@/ui/timeline/tracks/audio-unit/clips/constants.ts"

const className = Html.adoptStyleSheet(css, "TracksFooter")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TracksFooter = ({lifecycle, service}: Construct) => {
    const {clips} = service.timeline
    const scrollModel = new ScrollModel()
    let syncing = false
    const syncModel = () => {
        syncing = true
        scrollModel.visibleSize = clips.count.getValue() * ClipWidth
        scrollModel.contentSize = clips.columns.getValue() * ClipWidth
        scrollModel.position = clips.scroll.getValue() * ClipWidth
        syncing = false
    }
    syncModel()
    lifecycle.ownAll(
        scrollModel,
        clips.columns.subscribe(syncModel),
        clips.count.subscribe(syncModel),
        clips.scroll.subscribe(syncModel),
        scrollModel.subscribe(() => {
            if (syncing) {return}
            clips.scrollTo(Math.round(scrollModel.position / ClipWidth))
        })
    )
    return (
        <div className={className}>
            <TracksFooterHeader/>
            <div className="clips-scroller">
                <Scroller lifecycle={lifecycle} model={scrollModel} orientation={Orientation.horizontal}/>
            </div>
            <TimelineRangeSlider lifecycle={lifecycle}
                                 range={service.timeline.range}
                                 className="clips-aware"/>
        </div>
    )
}
