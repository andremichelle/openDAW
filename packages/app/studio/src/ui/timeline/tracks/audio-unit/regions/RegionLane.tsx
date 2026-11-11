import {Html} from "@opendaw/lib-dom"
import {Lifecycle, Option, Subscription, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {RegionRenderer} from "@/ui/timeline/tracks/audio-unit/regions/RegionRenderer.ts"
import {AudioRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {CanvasPainter, TimelineRange} from "@opendaw/studio-core"
import {RegionLaneClassName} from "@/ui/timeline/tracks/audio-unit/TrackStyles.ts"

const className = RegionLaneClassName

type Construct = {
    lifecycle: Lifecycle
    trackManager: TracksManager
    range: TimelineRange
    adapter: TrackBoxAdapter
}

export const RegionLane = ({lifecycle, trackManager, range, adapter}: Construct) => {
    let updated = false
    let visible = false
    const canvas: HTMLCanvasElement = <canvas/>
    const element: Element = (<div className={className}>{canvas}</div>)
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context}) => {
        if (visible) {
            RegionRenderer.render(context, trackManager, range, adapter.listIndex)
            updated = true
        }
    }))
    const requestUpdate = () => {
        updated = false
        painter.requestUpdate()
    }
    const {trackFocus, rootBoxAdapter} = trackManager.service.project
    const ownsRegion = (option: Option<AudioRegionBoxAdapter>): boolean =>
        option.mapOr(region => region.trackBoxAdapter.contains(adapter), false)
    let hoveredRegion: Option<AudioRegionBoxAdapter> = Option.None
    const grooveLabels = UUID.newSet<{uuid: UUID.Bytes, subscription: Subscription}>(entry => entry.uuid)
    lifecycle.ownAll(
        rootBoxAdapter.grooves.catchupAndSubscribe({
            onAdd: groove => grooveLabels.add({uuid: groove.uuid, subscription: groove.labelField.subscribe(requestUpdate)}),
            onRemove: groove => grooveLabels.removeByKeyIfExist(groove.uuid)?.subscription.terminate(),
            onReorder: () => {}
        }),
        {terminate: () => grooveLabels.forEach(entry => entry.subscription.terminate())},
        trackManager.hoveredAudioRegion.subscribe(option => {
            const next = option.map(region => region)
            if (ownsRegion(hoveredRegion) || ownsRegion(next)) {requestUpdate()}
            hoveredRegion = next
        }),
        range.subscribe(requestUpdate),
        adapter.regions.subscribeChanges(requestUpdate),
        adapter.enabled.subscribe(requestUpdate),
        trackManager.service.project.timelineBoxAdapter.signatureTrack.subscribe(requestUpdate),
        trackFocus.track.catchupAndSubscribe(owner =>
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