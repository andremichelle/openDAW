import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {AudioUnitBoxAdapter, AudioUnitGroups, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {CanvasPainter, TimeGrid} from "@opendaw/studio-core"
import {GroupOverviewLayout} from "./GroupOverviewLayout"
import {GroupOverviewUpdates} from "./GroupOverviewUpdates"
import {RegionLaneClassName} from "./TrackStyles"
import {RegionPaintBucket} from "./regions/RegionPaintBucket"
import {StudioService} from "@/service/StudioService"

type Construct = {lifecycle: Lifecycle, service: StudioService, unit: AudioUnitBox}

export const GroupOverview = ({lifecycle, service, unit}: Construct): HTMLElement => {
    const {project, timeline: {range}} = service
    const collapsed = project.userEditingManager.viewStates.groupCollapsed(unit)
    const canvas: HTMLCanvasElement = <canvas aria-label="Child clip overview"/>
    const element: HTMLElement = <div className={Html.buildClassList(RegionLaneClassName, "group-preview")}>{canvas}</div>
    element.dataset.groupOverview = ""
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context, width, height, devicePixelRatio: dpr}) => {
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.save()
        context.scale(dpr, dpr)
        context.fillStyle = "rgba(0, 0, 0, 0.3)"
        TimeGrid.fragment(project.timelineBoxAdapter.signatureTrack, range, ({pulse}) =>
            context.fillRect(Math.floor(range.unitToX(pulse)), 0, 1, height), {minLength: 32})
        if (collapsed.getValue()) {
            const lanes = AudioUnitGroups.subtree(project.rootBox, unit).filter(child => child !== unit)
                .flatMap(child => project.boxAdapters.adapterFor(child, AudioUnitBoxAdapter).tracks.values()
                    .filter(track => track.type === TrackType.Notes || track.type === TrackType.Audio)
                    .map(track => track.regions.collection.asArray().map(region => ({
                        position: region.position, complete: region.complete, hue: region.hue,
                        mute: region.mute || !track.enabled.getValue()
                    }))))
            for (const line of GroupOverviewLayout.lines(lanes, height, width, value => range.unitToX(value))) {
                context.fillStyle = RegionPaintBucket.create({hue: line.hue, mute: line.muted}, false, false).labelBackground
                context.fillRect(line.x, line.y, line.width, line.height)
            }
        }
        context.restore()
    }))
    lifecycle.ownAll(
        range.subscribe(painter.requestUpdate),
        GroupOverviewUpdates.subscribe(project, unit, painter.requestUpdate),
        collapsed.subscribe(painter.requestUpdate),
        project.timelineBoxAdapter.signatureTrack.subscribe(painter.requestUpdate)
    )
    return element
}
