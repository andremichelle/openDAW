import css from "./RegionLane.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {renderRegions} from "@/ui/timeline/tracks/audio-unit/regions/RegionRenderer.ts"
import {TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "RegionLane")

type Construct = {
    lifecycle: Lifecycle
    trackManager: TracksManager
    range: TimelineRange
    adapter: TrackBoxAdapter
}

export const RegionLane = ({lifecycle, trackManager, range, adapter}: Construct) => {
    if (adapter.type === TrackType.Undefined) {
        return <div className={Html.buildClassList(className, "deactive")}/>
    }
    let updated = false
    let visible = false
    const canvas: HTMLCanvasElement = <canvas/>
    const element: Element = (<div className={className}>{canvas}</div>)
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context}) => {
        if (visible) {
            renderRegions(context, trackManager, range, adapter.listIndex)
            updated = true
        }
    }))
    const requestUpdate = () => {
        updated = false
        painter.requestUpdate()
    }
    const {timelineFocus} = trackManager.service.project
    lifecycle.ownAll(
        range.subscribe(requestUpdate),
        adapter.regions.subscribeChanges(requestUpdate),
        adapter.enabled.subscribe(requestUpdate),
        trackManager.service.project.timelineBoxAdapter.catchupAndSubscribeSignature(requestUpdate),
        timelineFocus.track.catchupAndSubscribe(owner =>
            element.classList.toggle("focused", owner.contains(adapter))),
        Html.watchIntersection(element, entries => entries
                .forEach(({isIntersecting}) => {
                    visible = isIntersecting
                    if (!updated) {
                        painter.requestUpdate()
                    }
                }),
            {root: trackManager.scrollableContainer})
    )
    return element
}