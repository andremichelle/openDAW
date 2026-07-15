import {TransientMarkerBoxAdapter, WarpMarkerBoxAdapter, FilteredSelection} from "@opendaw/studio-adapters"
import {ContextMenu, MenuItem, Project, TimelineRange} from "@opendaw/studio-core"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {TransientMarkerBox} from "@opendaw/studio-boxes"
import {clamp, isNotNull, isNull, Nullable, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {DebugMenus} from "@/ui/menu/debug"
import {TransientMarkerUtils} from "@/ui/timeline/editors/audio/TransientMarkerUtils"
import {Dragging, Events, Keyboard} from "@opendaw/lib-dom"
import {EventCollection} from "@opendaw/lib-dsp"

export namespace TransientMarkerEditing {
    // Seconds domain — transients are audio-time features stored on the AudioFileBox, NOT the ppqn grid.
    export const MIN_DISTANCE_SECONDS = 0.050

    export const install = (project: Project,
                            canvas: HTMLCanvasElement,
                            range: TimelineRange,
                            reader: AudioEventOwnerReader,
                            warpMarkers: EventCollection<WarpMarkerBoxAdapter>,
                            transientMarkers: EventCollection<TransientMarkerBoxAdapter>): Terminable => {
        const terminator = new Terminator()
        const capturing = TransientMarkerUtils.createCapturing(canvas, range, reader, warpMarkers, transientMarkers)
        const {audioContent} = reader
        const {waveformOffset} = audioContent
        const transientMarkersField = Option.wrap(audioContent.file.box.transientMarkers)
        const selection: FilteredSelection<TransientMarkerBoxAdapter> = terminator.own(
            project.selection
                .createFilteredSelection(box => box instanceof TransientMarkerBox
                    && box.owner.targetVertex.equals(transientMarkersField), {
                    fx: adapter => adapter.box,
                    fy: vertex => project.boxAdapters.adapterFor(vertex.box, TransientMarkerBoxAdapter)
                }))
        const clientXToSeconds = (clientX: number): number => {
            const rect = canvas.getBoundingClientRect()
            const x = clientX - rect.left
            const localUnit = range.xToUnit(x) - reader.offset
            return TransientMarkerUtils.unitsToSeconds(localUnit, warpMarkers) + waveformOffset.getValue()
        }
        const findAdjacent = (seconds: number,
                              exceptBox: Nullable<TransientMarkerBox>): [Nullable<number>, Nullable<number>] => {
            let left: Nullable<number> = null
            let right: Nullable<number> = null
            for (const marker of transientMarkers.asArray()) {
                if (isNotNull(exceptBox) && marker.box === exceptBox) {continue}
                if (marker.position <= seconds) {left = marker.position} else {right = marker.position; break}
            }
            return [left, right]
        }
        terminator.ownAll(
            selection.catchupAndSubscribe({
                onSelected: (adapter: TransientMarkerBoxAdapter) => adapter.onSelected(),
                onDeselected: (adapter: TransientMarkerBoxAdapter) => adapter.onDeselected()
            }),
            ContextMenu.subscribe(canvas, collector => {
                const marker = capturing.captureEvent(collector.client)
                if (isNotNull(marker)) {
                    selection.deselectAll()
                    selection.select(marker)
                    collector.addItems(
                        MenuItem.default({label: "Remove transient marker"})
                            .setTriggerProcedure(() => project.editing.modify(() =>
                                selection.selected().forEach(marker => marker.box.delete()))),
                        DebugMenus.debugBox(marker.box, true)
                    )
                }
            }),
            Events.subscribeDblDwn(canvas, event => {
                const marker = capturing.captureEvent(event)
                if (isNotNull(marker)) {
                    project.editing.modify(() => marker.box.delete())
                } else {
                    const seconds = clientXToSeconds(event.clientX)
                    if (seconds < 0.0) {return}
                    const [left, right] = findAdjacent(seconds, null)
                    if (isNotNull(left) && seconds - left < MIN_DISTANCE_SECONDS) {return}
                    if (isNotNull(right) && right - seconds < MIN_DISTANCE_SECONDS) {return}
                    project.editing.modify(() => TransientMarkerBox.create(project.boxGraph, UUID.generate(), box => {
                        box.owner.refer(audioContent.file.box.transientMarkers)
                        box.position.setValue(seconds)
                    }))
                }
            }),
            Events.subscribe(canvas, "keydown", (event) => {
                if (Keyboard.isDelete(event)) {
                    project.editing.modify(() => selection.selected().forEach(marker => marker.box.delete()))
                }
            }),
            Dragging.attach(canvas, startEvent => {
                const marker = capturing.captureEvent(startEvent)
                selection.deselectAll()
                if (isNull(marker)) {return Option.None}
                selection.select(marker)
                return Option.wrap({
                    update: (event: Dragging.Event) => {
                        const seconds = clientXToSeconds(event.clientX)
                        const [left, right] = findAdjacent(seconds, marker.box)
                        const min = (left ?? 0.0) + MIN_DISTANCE_SECONDS
                        const max = (right ?? Number.MAX_SAFE_INTEGER) - MIN_DISTANCE_SECONDS
                        const clamped = clamp(Math.max(0.0, seconds), min, max)
                        project.editing.modify(() => marker.box.position.setValue(clamped), false)
                    },
                    approve: () => project.editing.mark()
                })
            }))
        return terminator
    }
}
