import {
    AudioPlayMode,
    FilteredSelection,
    TransientMarkerBoxAdapter,
    WarpMarkerBoxAdapter
} from "@moises-ai/studio-adapters"
import {ContextMenu, Project, TimelineRange} from "@moises-ai/studio-core"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {WarpMarkerBox} from "@moises-ai/studio-boxes"
import {
    clamp,
    isNotNull,
    isNull,
    Iterables,
    Nullable,
    ObservableValue,
    Option,
    Terminable,
    Terminator,
    UUID
} from "@moises-ai/lib-std"
import {MenuItem} from "@moises-ai/studio-core"
import {DebugMenus} from "@/ui/menu/debug"
import {WarpMarkerUtils} from "@/ui/timeline/editors/audio/WarpMarkerUtils"
import {Dragging, Events, Keyboard} from "@moises-ai/lib-dom"
import {PPQN} from "@moises-ai/lib-dsp"
import {Snapping} from "@/ui/timeline/Snapping"

export namespace WarpMarkerEditing {
    export const MIN_DISTANCE = PPQN.SemiQuaver

    const MARKER_RADIUS = 4

    export const install = (project: Project,
                            canvas: HTMLCanvasElement,
                            range: TimelineRange,
                            snapping: Snapping,
                            reader: AudioEventOwnerReader,
                            audioPlayMode: AudioPlayMode,
                            hoverTransient: ObservableValue<Nullable<TransientMarkerBoxAdapter>>): Terminable => {
        const terminator = new Terminator()
        const capturing = WarpMarkerUtils.createCapturing(canvas, range, reader, MARKER_RADIUS)
        const warpMarkersField = reader.audioContent.observableOptPlayMode.map(playMode => playMode.box.warpMarkers)
        const selection: FilteredSelection<WarpMarkerBoxAdapter> = terminator.own(
            project.selection
                .createFilteredSelection(box => box instanceof WarpMarkerBox
                    && box.owner.targetVertex.equals(warpMarkersField), {
                    fx: adapter => adapter.box,
                    fy: vertex => project.boxAdapters.adapterFor(vertex.box, WarpMarkerBoxAdapter)
                }))
        const {warpMarkers, box: audioPlayModeBox} = audioPlayMode
        const {audioContent: {waveformOffset}} = reader
        terminator.ownAll(
            selection.catchupAndSubscribe({
                onSelected: (adapter: WarpMarkerBoxAdapter) => adapter.onSelected(),
                onDeselected: (adapter: WarpMarkerBoxAdapter) => adapter.onDeselected()
            }),
            ContextMenu.subscribe(canvas, collector => {
                const marker = capturing.captureEvent(collector.client)
                if (isNotNull(marker)) {
                    selection.deselectAll()
                    selection.select(marker)
                    collector.addItems(
                        MenuItem.default({
                            label: "Remove warp marker",
                            selectable: !marker.isAnchor
                        }).setTriggerProcedure(() => {
                            project.editing.modify(() => selection.selected()
                                .filter(marker => !marker.isAnchor)
                                .forEach(marker => marker.box.delete()))
                        }),
                        DebugMenus.debugBox(marker.box, true)
                    )
                }
            }),
            Events.subscribeDblDwn(canvas, event => {
                const marker = capturing.captureEvent(event)
                if (isNotNull(marker)) {
                    if (!marker.isAnchor) {
                        project.editing.modify(() => marker.box.delete())
                    }
                } else {
                    const transient = hoverTransient.getValue()
                    if (isNull(transient)) {
                        const rect = canvas.getBoundingClientRect()
                        const x = event.clientX - rect.left
                        const unit = event.shiftKey ? range.xToUnit(x) : snapping.xToUnitRound(x)
                        const local = unit - reader.offset
                        const adjacentWarpMarkers = WarpMarkerUtils.findAdjacent(local, warpMarkers, true)
                        if (isNull(adjacentWarpMarkers)) {return}
                        const [left, right] = adjacentWarpMarkers
                        if (isNull(left) || isNull(right)) {return}
                        if (local - left.position < MIN_DISTANCE || right.position - local < MIN_DISTANCE) {return}
                        const clamped = clamp(local, left.position + MIN_DISTANCE, right.position - MIN_DISTANCE)
                        const alpha = (clamped - left.position) / (right.position - left.position)
                        const seconds = left.seconds + alpha * (right.seconds - left.seconds)
                        project.editing.modify(() => WarpMarkerBox.create(project.boxGraph, UUID.generate(), box => {
                            box.owner.refer(audioPlayMode.box.warpMarkers)
                            box.position.setValue(local)
                            box.seconds.setValue(seconds)
                        }))
                    } else {
                        const adjustedSeconds = transient.position - waveformOffset.getValue()
                        const markers = warpMarkers.asArray()
                        if (markers.length < 2) {return}
                        const first = markers[0]
                        const second = markers[1]
                        const secondLast = markers[markers.length - 2]
                        const last = markers[markers.length - 1]
                        const firstRate = (second.position - first.position) / (second.seconds - first.seconds)
                        const lastRate = (last.position - secondLast.position) / (last.seconds - secondLast.seconds)
                        let position: number
                        if (adjustedSeconds < first.seconds) {
                            position = first.position + (adjustedSeconds - first.seconds) * firstRate
                        } else if (adjustedSeconds > last.seconds) {
                            position = last.position + (adjustedSeconds - last.seconds) * lastRate
                        } else {
                            let found = false
                            for (const [left, right] of Iterables.pairWise(markers)) {
                                if (isNull(right)) {break}
                                if (left.seconds <= adjustedSeconds && adjustedSeconds <= right.seconds) {
                                    const alpha = (adjustedSeconds - left.seconds) / (right.seconds - left.seconds)
                                    position = left.position + alpha * (right.position - left.position)
                                    found = true
                                    break
                                }
                            }
                            if (!found) {return}
                        }
                        const [adjLeft, adjRight] = WarpMarkerUtils.findAdjacent(position!, warpMarkers, true)
                        if (isNull(adjLeft) || isNull(adjRight)) {return}
                        if (position! - adjLeft.position < MIN_DISTANCE || adjRight.position - position! < MIN_DISTANCE) {return}
                        project.editing.modify(() => WarpMarkerBox.create(project.boxGraph, UUID.generate(), box => {
                            box.owner.refer(audioPlayModeBox.warpMarkers)
                            box.position.setValue(position!)
                            box.seconds.setValue(adjustedSeconds)
                        }))
                    }
                }
            }),
            Events.subscribe(canvas, "keydown", (event) => {
                if (Keyboard.isDelete(event)) {
                    project.editing.modify(() => selection.selected()
                        .filter(marker => !marker.isAnchor)
                        .forEach(marker => marker.box.delete()))
                }
            }),
            Dragging.attach(canvas, startEvent => {
                const marker = capturing.captureEvent(startEvent)
                selection.deselectAll()
                if (isNull(marker)) {return Option.None}
                selection.select(marker)
                const [left, right] = WarpMarkerUtils.findAdjacent(marker.position, warpMarkers, false)
                if (isNull(left) && isNull(right)) {
                    console.warn("Broken warp-markers")
                    return Option.None
                }
                return Option.wrap({
                    update: (event: Dragging.Event) => {
                        const rect = canvas.getBoundingClientRect()
                        const x = event.clientX - rect.left
                        const unit = event.shiftKey ? range.xToUnit(x) : snapping.xToUnitRound(x)
                        const local = unit - reader.offset
                        const min = left?.position ?? Number.MIN_SAFE_INTEGER
                        const max = right?.position ?? Number.MAX_SAFE_INTEGER
                        const clamped = clamp(local, min + MIN_DISTANCE, max - MIN_DISTANCE)
                        project.editing.modify(() => marker.box.position.setValue(clamped), false)
                    },
                    approve: () => project.editing.mark()
                })
            }))
        return terminator
    }
}