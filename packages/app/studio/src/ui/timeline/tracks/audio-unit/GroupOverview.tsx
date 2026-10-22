import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {AudioUnitBoxAdapter, AudioUnitGroups, TrackType} from "@opendaw/studio-adapters"
import {CanvasPainter, TimeGrid} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {RegionLaneClassName} from "./TrackStyles"
import {groupOverviewLayout} from "./GroupOverviewLayout"

type Construct = {lifecycle: Lifecycle, service: StudioService, unit: AudioUnitBox}

/** Read-only arrangement summary, including descendants hidden by nested folders. */
export const GroupOverview = ({lifecycle, service, unit}: Construct): HTMLElement => {
    const {project, timeline: {range}} = service
    const canvas: HTMLCanvasElement = <canvas aria-label="Child clip overview"/>
    const element: HTMLElement = <div className={RegionLaneClassName}>{canvas}</div>
    element.dataset.groupOverview = ""
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context, width, height, devicePixelRatio: dpr}) => {
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.save()
        context.scale(dpr, dpr)
        context.fillStyle = "rgba(0, 0, 0, 0.3)"
        TimeGrid.fragment(project.timelineBoxAdapter.signatureTrack, range, ({pulse}) =>
            context.fillRect(Math.floor(range.unitToX(pulse)), 0, 1, height), {minLength: 32})
        if (unit.groupCollapsed.getValue()) {
            const lanes = AudioUnitGroups.subtree(project.rootBox, unit).filter(child => child !== unit)
                .flatMap(child => project.boxAdapters.adapterFor(child, AudioUnitBoxAdapter).tracks.values()
                    .filter(track => track.type === TrackType.Notes || track.type === TrackType.Audio)
                    .map(track => track.regions.collection.asArray().map(region => ({
                        position: region.position, complete: region.complete, hue: region.hue,
                        mute: region.mute || !track.enabled.getValue()
                    }))))
            for (const line of groupOverviewLayout(lanes, height, width, value => range.unitToX(value))) {
                context.fillStyle = `hsl(${line.hue}, ${line.muted ? 5 : 75}%, 55%)`
                context.fillRect(line.x, line.y, line.width, line.height)
            }
        }
        context.restore()
    }))
    lifecycle.ownAll(
        range.subscribe(painter.requestUpdate),
        // Graph updates include region colors/timing, hierarchy, undo, and remote edits. CanvasPainter
        // coalesces them into one frame; no idle polling or per-descendant subscriptions are needed.
        project.boxGraph.subscribeToAllUpdates({onUpdate: () => {
            if (unit.groupCollapsed.getValue()) {painter.requestUpdate()}
        }}),
        unit.groupCollapsed.subscribe(painter.requestUpdate),
        project.timelineBoxAdapter.signatureTrack.subscribe(painter.requestUpdate)
    )
    return element
}
