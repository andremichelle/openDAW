import css from "./ChordTrackBody.sass?inline"
import {isDefined, Lifecycle, Nullable, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Dragging, Events, Html, ShortcutManager} from "@opendaw/lib-dom"
import {ClipboardManager, ElementCapturing} from "@opendaw/studio-core"
import {ChordEventBox} from "@opendaw/studio-boxes"
import {ChordEventBoxAdapter} from "@opendaw/studio-adapters"
import {ppqn} from "@opendaw/lib-dsp"
import {StudioService} from "@/service/StudioService.ts"
import {ChordRenderer} from "@/ui/timeline/tracks/primary/chord/ChordRenderer"
import {ChordContextMenu} from "@/ui/timeline/tracks/primary/chord/ChordContextMenu"
import {ChordPreview} from "@/ui/timeline/tracks/primary/chord/ChordPreview"
import {ChordOverlaps} from "@/ui/timeline/tracks/primary/chord/ChordOverlaps"
import {ChordClipboard} from "@/ui/timeline/tracks/primary/chord/ChordClipboard"
import {SelectionRectangle} from "@/ui/timeline/SelectionRectangle"
import {TimelineSelectableLocator} from "@/ui/timeline/TimelineSelectableLocator"
import {ChordTrackShortcuts, DegreeShortcuts} from "@/ui/shortcuts/ChordTrackShortcuts"

const className = Html.adoptStyleSheet(css, "chord-track-body")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

const ResizeHandleWidth = 6

export const ChordTrackBody = ({lifecycle, service}: Construct) => {
    const {project, timeline: {range, snapping}} = service
    const {editing, boxGraph, boxAdapters, engine, timelineBoxAdapter: {chordTrack}} = project
    const {events} = chordTrack
    const canvas: HTMLCanvasElement = <canvas tabIndex={-1} style={{fontSize: "1.25em"}}/>
    const element: HTMLElement = <div className={className}>{canvas}</div>
    const selection = lifecycle.own(project.selection.createFilteredSelection(box => box instanceof ChordEventBox
        && box.track.targetVertex.contains(chordTrack.object.events), {
        fx: (adapter: ChordEventBoxAdapter) => adapter.box,
        fy: vertex => boxAdapters.adapterFor(vertex.box, ChordEventBoxAdapter)
    }))
    let modifier: Nullable<ChordRenderer.Modifier> = null
    const {requestUpdate} = lifecycle.own(ChordRenderer.createTrackRenderer(canvas, range, chordTrack,
        adapter => selection.isSelected(adapter), () => modifier))
    const preview = (adapter: ChordEventBoxAdapter) => chordTrack.resolve(adapter)
        .ifSome(chord => ChordPreview.play(project, chord))
    const hold = (adapter: ChordEventBoxAdapter) => chordTrack.resolve(adapter)
        .mapOr(chord => ChordPreview.start(project, chord), Terminable.Empty)
    const capturing = new ElementCapturing<ChordEventBoxAdapter>(canvas, {
        capture: (localX: number, _localY: number): Nullable<ChordEventBoxAdapter> =>
            chordTrack.eventAt(range.xToUnit(localX))
    })
    const resizeTarget = (localX: number): Nullable<ChordEventBoxAdapter> => {
        const event = chordTrack.eventAt(range.xToUnit(localX))
        return isDefined(event) && range.unitToX(event.complete) - localX <= ResizeHandleWidth ? event : null
    }
    const targetAt = (localX: number): Nullable<ChordEventBoxAdapter> =>
        resizeTarget(localX) ?? chordTrack.eventAt(range.xToUnit(localX))
    const locator: TimelineSelectableLocator<ChordEventBoxAdapter> = {
        selectableAt: ({u}) => Option.wrap(targetAt(range.unitToX(u))).mapOr(adapter => [adapter], []),
        selectablesBetween: ({u: min}, {u: max}) =>
            events.asArray().filter(adapter => adapter.position < max && adapter.complete > min),
        selectable: () => events.asArray()
    }
    const targetsOf = (adapter: ChordEventBoxAdapter): ReadonlyArray<ChordEventBoxAdapter> => {
        if (selection.isSelected(adapter)) {return selection.selected()}
        selection.deselectAll()
        selection.select(adapter)
        return [adapter]
    }
    const clipboardContext: ChordClipboard.Context = {
        getEnabled: () => !engine.isPlaying.getValue(),
        getPosition: () => engine.position.getValue(),
        setPosition: position => engine.setPosition(position),
        editing, selection, chordTrack, boxGraph, boxAdapters
    }
    const shortcuts = ShortcutManager.get().createContext(element, "ChordTrack")
    lifecycle.ownAll(
        shortcuts,
        selection.catchupAndSubscribe({onSelected: requestUpdate, onDeselected: requestUpdate}),
        Events.subscribe(canvas, "pointermove", (event: PointerEvent) => {
            if (event.buttons !== 0) {return}
            const localX = event.clientX - canvas.getBoundingClientRect().left
            canvas.style.cursor = isDefined(resizeTarget(localX)) ? "ew-resize" : ""
        }),
        Events.subscribe(element, "pointerdown", () => canvas.focus()),
        range.subscribe(requestUpdate),
        chordTrack.subscribe(requestUpdate),
        ChordContextMenu.install(canvas, capturing, editing, targetsOf, preview),
        ClipboardManager.install(element, ChordClipboard.createHandler(clipboardContext)),
        shortcuts.register(ChordTrackShortcuts["select-all"].shortcut, () => selection.select(...events.asArray())),
        shortcuts.register(ChordTrackShortcuts["deselect-all"].shortcut, () => selection.deselectAll()),
        shortcuts.register(ChordTrackShortcuts["delete-selection"].shortcut, () => {
            const selected = selection.selected()
            if (selected.length === 0) {return false}
            editing.modify(() => selected.forEach(({box}) => box.delete()))
            return true
        }),
        shortcuts.register(ChordTrackShortcuts["duplicate-chords"].shortcut, () => {
            const selected = selection.selected()
            if (selected.length === 0) {return false}
            const {min, max} = ChordClipboard.extent(selected)
            const data = ChordClipboard.serialize(selected)
            editing.modify(() => ChordClipboard.insert(clipboardContext, data, max - min))
            return true
        }),
        ...DegreeShortcuts.map(({shortcut}, index) => shortcuts.register(shortcut, () => {
            const selected = selection.selected()
            if (selected.length === 0) {return false}
            editing.modify(() => selected.forEach(({box}) => box.degree.setValue(index + 1)))
            preview(selected[0])
            return true
        })),
        Events.subscribeDblDwn(element, (event: PointerEvent) => {
            const localX = event.clientX - canvas.getBoundingClientRect().left
            if (isDefined(targetAt(localX))) {return}
            const {position, complete} = snapping.xToBarInterval(localX)
            const next = events.greaterEqual(position)
            const end = isDefined(next) ? Math.min(complete, next.position) : complete
            if (end <= position) {return}
            editing.modify(() => {
                const box = ChordEventBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(end - position)
                    box.degree.setValue(1)
                    box.track.refer(chordTrack.object.events)
                })
                const created = boxAdapters.adapterFor(box, ChordEventBoxAdapter)
                selection.deselectAll()
                selection.select(created)
                return created
            }).ifSome(preview)
        })
    )
    element.appendChild(
        <SelectionRectangle lifecycle={lifecycle}
                            target={element}
                            selection={selection}
                            locator={locator}
                            xAxis={range.valueAxis}
                            yAxis={{axisToValue: y => y, valueToAxis: value => value}}/>
    )
    lifecycle.own(Dragging.attach(element, (startEvent: PointerEvent) => {
        const localX = startEvent.clientX - canvas.getBoundingClientRect().left
        const resizeAdapter = resizeTarget(localX)
        const adapter = resizeAdapter ?? chordTrack.eventAt(range.xToUnit(localX))
        if (!isDefined(adapter) || !selection.isSelected(adapter)) {return Option.None}
        const selected = selection.selected().slice()
        const minPosition = Math.min(...selected.map(({position}) => position))
        const limits = selected.map(({complete}) => Math.min(...selected
            .map(other => other.position).filter(other => other >= complete), Number.POSITIVE_INFINITY))
        const playing = new Terminator()
        playing.own(hold(adapter))
        const pointerPulse = range.xToUnit(localX)
        const resizing = adapter === resizeAdapter
        const state = {copy: false, deltaPosition: 0, deltaDuration: 0}
        const readPosition = (chord: ChordEventBoxAdapter): ppqn => chord.position + (resizing ? 0 : state.deltaPosition)
        const readComplete = (chord: ChordEventBoxAdapter): ppqn => {
            const {position, duration} = chord
            if (!resizing) {return chord.complete + state.deltaPosition}
            return Math.min(limits[selected.indexOf(chord)],
                position + Math.max(Math.min(snapping.value(position), duration), duration + state.deltaDuration))
        }
        modifier = {
            get copy(): boolean {return state.copy},
            adapters: selected,
            readPosition,
            readComplete
        }
        return Option.wrap({
            update: (event: Dragging.Event) => {
                const x = event.clientX - canvas.getBoundingClientRect().left
                state.copy = !resizing && event.ctrlKey
                if (resizing) {
                    state.deltaDuration = snapping.computeDelta(pointerPulse, x, adapter.complete)
                } else {
                    state.deltaPosition = Math.max(-minPosition, snapping.computeDelta(pointerPulse, x, adapter.position))
                }
                if (state.deltaPosition !== 0 || state.deltaDuration !== 0) {playing.terminate()}
                requestUpdate()
            },
            approve: () => {
                if (selected.some(chord => !events.contains(chord))) {return}
                if (state.deltaPosition === 0 && state.deltaDuration === 0 && !state.copy) {return}
                editing.modify(() => {
                    const targets = state.copy
                        ? ChordClipboard.insert(clipboardContext, ChordClipboard.serialize(selected), state.deltaPosition)
                        : selected.map(chord => {
                            const position = readPosition(chord)
                            const complete = readComplete(chord)
                            chord.box.position.setValue(position)
                            chord.box.duration.setValue(complete - position)
                            return chord
                        })
                    targets.forEach(target => ChordOverlaps.resolve(chordTrack, target, targets))
                })
            },
            finally: () => {
                modifier = null
                playing.terminate()
                requestUpdate()
            }
        } satisfies Dragging.Process)
    }, {permanentUpdates: true}))
    return element
}
