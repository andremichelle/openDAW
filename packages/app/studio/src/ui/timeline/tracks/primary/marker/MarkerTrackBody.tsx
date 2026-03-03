import css from "./MarkerTrackBody.sass?inline"
import {int, isDefined, Lifecycle, Nullable, Option, UUID} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {MarkerBoxAdapter, MarkerTrackAdapter, TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {createElement} from "@opendaw/lib-jsx"
import {ElementCapturing} from "../../../../../../../../studio/core/src/ui/canvas/capturing.ts"
import {MarkerBox} from "@opendaw/studio-boxes"
import {MarkerRenderer} from "@/ui/timeline/tracks/primary/marker/MarkerRenderer"
import {MarkerContextMenu} from "@/ui/timeline/tracks/primary/marker/MarkerContextMenu"
import {Markers} from "@/ui/timeline/tracks/primary/marker/Markers"
import {Dragging, Events, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "marker-track-body")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MarkerTrackBody = ({lifecycle, service}: Construct) => {
    const {project, timeline} = service
    const {editing, engine, boxGraph} = project
    const {range, snapping} = timeline
    const markerState = engine.markerState
    const canvas: HTMLCanvasElement = <canvas style={{fontSize: "1.25em"}}/>
    const position = engine.position
    const timelineAdapter = project.boxAdapters.adapterFor(project.timelineBox, TimelineBoxAdapter)
    const markerTrackAdapter: MarkerTrackAdapter = timelineAdapter.markerTrack
    const events = markerTrackAdapter.events
    const {
        context,
        requestUpdate
    } = lifecycle.own(MarkerRenderer.createTrackRenderer(canvas, range, markerTrackAdapter, markerState))
    const capturing = new ElementCapturing<MarkerBoxAdapter>(canvas, {
        capture: (localX: number, _localY: number): Nullable<MarkerBoxAdapter> => {
            const pointer = range.xToUnit(localX)
            const marker = events.lowerEqual(pointer)
            if (marker === null) {return null}
            const state: Nullable<[UUID.Bytes, int]> = markerState.getValue()
            let markerWidth: number
            if (state === null || !UUID.equals(marker.uuid, state[0])) {
                markerWidth = MarkerRenderer.computeWidth(context, marker, false, 1)
            } else {
                markerWidth = MarkerRenderer.computeWidth(context, marker, true, state[1])
            }
            return localX - range.unitToX(marker.position) < markerWidth ? marker : null
        }
    })
    let lastTimeDown = 0
    lifecycle.ownAll(
        position.subscribe(requestUpdate),
        range.subscribe(requestUpdate),
        markerTrackAdapter.subscribe(requestUpdate),
        markerState.catchupAndSubscribe(requestUpdate),
        MarkerContextMenu.install(canvas, range, capturing, editing),
        Dragging.attach(canvas, (startEvent: PointerEvent) => {
            const now = Date.now()
            const dblclck = now - lastTimeDown < Events.DOUBLE_DOWN_THRESHOLD
            lastTimeDown = now
            const adapter = capturing.captureEvent(startEvent)
            if (adapter === null) {
                if (dblclck) {
                    const rect = canvas.getBoundingClientRect()
                    const position = snapping.xToUnitFloor(startEvent.clientX - rect.left)
                    const lowerEqual = markerTrackAdapter.events.lowerEqual(position)
                    if (lowerEqual?.position === position) {return Option.None}
                    const label = isDefined(lowerEqual) ? Markers.nextName(lowerEqual.label) : Markers.DefaultNames[0]
                    editing.modify(() => MarkerBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(position)
                        box.label.setValue(label)
                        box.hue.setValue(190)
                        box.track.refer(markerTrackAdapter.object.markers)
                    }))
                }
                return Option.None
            }
            const oldPosition = adapter.position
            return Option.wrap({
                update: (event: Dragging.Event) => {
                    const rect = canvas.getBoundingClientRect()
                    const position = snapping.xToUnitFloor(event.clientX - rect.left)
                    editing.modify(() => {
                        const atPosition = events.lowerEqual(position)
                        if (atPosition !== null && atPosition.position === position && atPosition !== adapter) {
                            atPosition.box.delete()
                        }
                        adapter.box.position.setValue(position)
                    }, false)
                },
                cancel: () => editing.modify(() => adapter.box.position.setValue(oldPosition)),
                approve: () => editing.mark()
            } satisfies Dragging.Process)
        })
    )
    return (<div className={className}>{canvas}</div>)
}