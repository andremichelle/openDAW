import css from "./KeyTrackBody.sass?inline"
import {isDefined, Lifecycle, Nullable, Option, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {ElementCapturing} from "@opendaw/studio-core"
import {KeyEventBox} from "@opendaw/studio-boxes"
import {KeyEventBoxAdapter, TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {KeyRenderer} from "@/ui/timeline/tracks/primary/key/KeyRenderer"
import {KeyContextMenu} from "@/ui/timeline/tracks/primary/key/KeyContextMenu"

const className = Html.adoptStyleSheet(css, "key-track-body")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const KeyTrackBody = ({lifecycle, service}: Construct) => {
    const {project, timeline: {range, snapping}} = service
    const {editing, engine, boxGraph} = project
    const canvas: HTMLCanvasElement = <canvas style={{fontSize: "1.25em"}}/>
    const keyTrack = project.boxAdapters.adapterFor(project.timelineBox, TimelineBoxAdapter).keyTrack
    const {events} = keyTrack
    const {context, requestUpdate} = lifecycle.own(KeyRenderer.createTrackRenderer(canvas, range, keyTrack))
    const capturing = new ElementCapturing<KeyEventBoxAdapter>(canvas, {
        capture: (localX: number, _localY: number): Nullable<KeyEventBoxAdapter> => {
            const event = events.lowerEqual(range.xToUnit(localX))
            if (!isDefined(event)) {return null}
            return localX - range.unitToX(event.position) < KeyRenderer.computeWidth(context, event) ? event : null
        }
    })
    let lastTimeDown = 0
    lifecycle.ownAll(
        range.subscribe(requestUpdate),
        keyTrack.subscribe(requestUpdate),
        KeyContextMenu.install(canvas, capturing, editing),
        Dragging.attach(canvas, (startEvent: PointerEvent) => {
            const now = Date.now()
            const doubleClick = now - lastTimeDown < Events.DOUBLE_DOWN_THRESHOLD
            lastTimeDown = now
            const adapter = capturing.captureEvent(startEvent)
            if (!isDefined(adapter)) {
                if (doubleClick) {
                    const position = snapping.xToUnitFloor(startEvent.clientX - canvas.getBoundingClientRect().left)
                    if (events.lowerEqual(position)?.position === position) {return Option.None}
                    const {root, bits} = keyTrack.keyAt(position)
                    editing.modify(() => KeyEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(position)
                        box.root.setValue(root)
                        box.scale.setValue(bits)
                        box.track.refer(keyTrack.object.events)
                    }))
                }
                return Option.None
            }
            const oldPosition = adapter.position
            const pointerPulse = range.xToUnit(startEvent.clientX - canvas.getBoundingClientRect().left)
            engine.setPosition(oldPosition)
            return Option.wrap({
                update: (event: Dragging.Event) => {
                    const rect = canvas.getBoundingClientRect()
                    const position = Math.max(0,
                        oldPosition + snapping.computeDelta(pointerPulse, event.clientX - rect.left, oldPosition))
                    editing.modify(() => {
                        const atPosition = events.lowerEqual(position)
                        if (isDefined(atPosition) && atPosition.position === position && atPosition !== adapter) {
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
