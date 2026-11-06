import css from "./ChordTrackBody.sass?inline"
import {isDefined, Lifecycle, Nullable, Option, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Events, Html, Keyboard} from "@opendaw/lib-dom"
import {ElementCapturing} from "@opendaw/studio-core"
import {ChordEventBox} from "@opendaw/studio-boxes"
import {ChordEventBoxAdapter, TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService.ts"
import {ChordRenderer} from "@/ui/timeline/tracks/primary/chord/ChordRenderer"
import {ChordContextMenu} from "@/ui/timeline/tracks/primary/chord/ChordContextMenu"
import {ChordPreview} from "@/ui/timeline/tracks/primary/chord/ChordPreview"

const className = Html.adoptStyleSheet(css, "chord-track-body")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const ResizeHandleWidth = 6

export const ChordTrackBody = ({lifecycle, service}: Construct) => {
    const {project, timeline: {range, snapping}} = service
    const {editing, boxGraph} = project
    const canvas: HTMLCanvasElement = <canvas tabIndex={-1} style={{fontSize: "1.25em"}}/>
    const chordTrack = project.boxAdapters.adapterFor(project.timelineBox, TimelineBoxAdapter).chordTrack
    const {events} = chordTrack
    let selected: Nullable<ChordEventBoxAdapter> = null
    const {requestUpdate} = lifecycle.own(ChordRenderer.createTrackRenderer(canvas, range, chordTrack, () => selected))
    const preview = (adapter: ChordEventBoxAdapter) => chordTrack.resolve(adapter)
        .ifSome(chord => ChordPreview.play(project, chord))
    const select = (adapter: Nullable<ChordEventBoxAdapter>) => {
        selected = adapter
        requestUpdate()
    }
    const capturing = new ElementCapturing<ChordEventBoxAdapter>(canvas, {
        capture: (localX: number, _localY: number): Nullable<ChordEventBoxAdapter> =>
            chordTrack.eventAt(range.xToUnit(localX))
    })
    let lastTimeDown = 0
    lifecycle.ownAll(
        range.subscribe(requestUpdate),
        chordTrack.subscribe(() => {
            if (isDefined(selected) && !events.contains(selected)) {selected = null}
            requestUpdate()
        }),
        ChordContextMenu.install(canvas, capturing, editing, preview),
        Events.subscribe(canvas, "keydown", (event: KeyboardEvent) => {
            if (!isDefined(selected)) {return}
            const adapter = selected
            if (event.code.startsWith("Digit")) {
                const degree = parseInt(event.code.substring(5))
                if (degree < 1 || degree > 7) {return}
                event.preventDefault()
                editing.modify(() => adapter.box.degree.setValue(degree))
                preview(adapter)
            } else if (Keyboard.isDelete(event)) {
                event.preventDefault()
                editing.modify(() => adapter.box.delete())
            }
        }),
        Dragging.attach(canvas, (startEvent: PointerEvent) => {
            canvas.focus()
            const now = Date.now()
            const doubleClick = now - lastTimeDown < Events.DOUBLE_DOWN_THRESHOLD
            lastTimeDown = now
            const localX = startEvent.clientX - canvas.getBoundingClientRect().left
            const adapter = capturing.captureEvent(startEvent)
            if (!isDefined(adapter)) {
                select(null)
                if (doubleClick) {
                    const {position, complete} = snapping.xToBarInterval(localX)
                    const next = events.greaterEqual(position)
                    const end = isDefined(next) ? Math.min(complete, next.position) : complete
                    if (end <= position) {return Option.None}
                    const box = editing.modify(() => ChordEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(position)
                        box.duration.setValue(end - position)
                        box.degree.setValue(1)
                        box.track.refer(chordTrack.object.events)
                    }))
                    box.ifSome(box => {
                        const created = project.boxAdapters.adapterFor(box, ChordEventBoxAdapter)
                        select(created)
                        preview(created)
                    })
                }
                return Option.None
            }
            select(adapter)
            preview(adapter)
            const pointerPulse = range.xToUnit(localX)
            const oldPosition = adapter.position
            const oldDuration = adapter.duration
            const resizing = range.unitToX(adapter.complete) - localX < ResizeHandleWidth
            return Option.wrap({
                update: (event: Dragging.Event) => {
                    const x = event.clientX - canvas.getBoundingClientRect().left
                    editing.modify(() => {
                        if (resizing) {
                            const complete = oldPosition + oldDuration
                            const newComplete = complete + snapping.computeDelta(pointerPulse, x, complete)
                            adapter.box.duration.setValue(Math.max(snapping.value(oldPosition), newComplete - oldPosition))
                        } else {
                            adapter.box.position.setValue(Math.max(0,
                                oldPosition + snapping.computeDelta(pointerPulse, x, oldPosition)))
                        }
                    }, false)
                },
                cancel: () => editing.modify(() => {
                    adapter.box.position.setValue(oldPosition)
                    adapter.box.duration.setValue(oldDuration)
                }),
                approve: () => editing.mark()
            } satisfies Dragging.Process)
        })
    )
    return (<div className={className}>{canvas}</div>)
}
