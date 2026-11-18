import {clamp, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {Dragging, Events, Key, Shortcut} from "@opendaw/lib-dom"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"
import {TimeSelection} from "@/ui/timeline/TimeSelection"
import {TimeEditing} from "@/ui/timeline/TimeEditing"
import {RegionsShortcuts} from "@/ui/shortcuts/RegionsShortcuts"
import {Dialogs} from "@/ui/components/dialogs"
import {RegionsToolContext} from "@/ui/timeline/tracks/audio-unit/regions/RegionsToolContext"

export namespace TimeSelectionTool {
    const EdgeRadius = 4

    type Hit = "outside" | "inside" | "start" | "complete"

    export const install = ({service, manager, range, element, shortcuts}: RegionsToolContext): Terminable => {
        const {project, timeline: {snapping, timeSelection}} = service
        const {editing, audioUnitFreeze, boxGraph, boxAdapters, timelineBoxAdapter} = project
        const lifecycle = new Terminator()
        const localX = (clientX: number): number => clientX - element.getBoundingClientRect().left
        const rowKeys = (from: number, to: number): TimeSelection["rows"] => {
            const rows = UUID.newSet<UUID.Bytes>(uuid => uuid)
            manager.timeRows().slice(Math.min(from, to), Math.max(from, to) + 1).forEach(({key}) => rows.add(key))
            return rows
        }
        const hitTest = (clientX: number, clientY: number): Hit => timeSelection.match({
            none: (): Hit => "outside",
            some: ({position, complete, rows, global}): Hit => {
                const timeRows = manager.timeRows()
                const index = TimeSelection.rowIndexAt(timeRows, clientY)
                const first = timeRows.findIndex(({key}) => rows.hasKey(key))
                const last = timeRows.findLastIndex(({key}) => rows.hasKey(key))
                if (!global && (first === -1 || index < first || index > last)) {return "outside"}
                const x = localX(clientX)
                const x0 = range.unitToX(position)
                const x1 = range.unitToX(complete)
                if (Math.abs(x - x0) <= EdgeRadius) {return "start"}
                if (Math.abs(x - x1) <= EdgeRadius) {return "complete"}
                return x0 < x && x < x1 ? "inside" : "outside"
            }
        })
        const apply = async (action: "delete" | "insert"): Promise<void> => {
            if (timeSelection.isEmpty()) {return}
            const selection = timeSelection.unwrap()
            const tracks = manager.timeTracks(selection)
            const units = UUID.newSet<AudioUnitBoxAdapter>(unit => unit.uuid)
            tracks.forEach(track => units.add(boxAdapters.adapterFor(track.audioUnit, AudioUnitBoxAdapter)))
            const frozen = units.values().filter(unit => audioUnitFreeze.isFrozen(unit))
            if (frozen.length > 0) {
                const approved = await Dialogs.approve({
                    headline: "Frozen Tracks",
                    message: `${frozen.length === 1 ? "A frozen track is" : `${frozen.length} frozen tracks are`} part of the time selection. Unfreeze, edit and render again?`,
                    approveText: "Render Again"
                })
                if (!approved) {return}
                frozen.forEach(unit => audioUnitFreeze.unfreeze(unit))
            }
            const {position, complete, global} = selection
            const globals: ReadonlyArray<TimeEditing.Global> = global ? [{timeline: timelineBoxAdapter, boxGraph}] : []
            editing.modify(() => action === "delete"
                ? TimeEditing.deleteTime(tracks, globals, position, complete)
                : TimeEditing.insertTime(tracks, globals, position, complete - position))
            for (const unit of frozen) {await audioUnitFreeze.freeze(unit)}
        }
        const startCreate = (event: PointerEvent): Dragging.Process => {
            const origin = snapping.xToUnitRound(localX(event.clientX))
            const startIndex = TimeSelection.rowIndexAt(manager.timeRows(), event.clientY)
            const update = ({clientX, clientY, shiftKey}: Dragging.Event): void => {
                const pointerPulse = snapping.xToUnitRound(localX(clientX))
                const rows = rowKeys(startIndex, TimeSelection.rowIndexAt(manager.timeRows(), clientY))
                timeSelection.wrap({
                    position: Math.max(0, Math.min(origin, pointerPulse)),
                    complete: Math.max(0, origin, pointerPulse), rows, global: shiftKey
                })
            }
            update(event)
            return {
                update,
                finally: () => timeSelection.ifSome(({position, complete}) => {
                    if (complete <= position) {timeSelection.clear()}
                })
            }
        }
        const startResize = (selection: TimeSelection, edge: "start" | "complete"): Dragging.Process => {
            const anchor: ppqn = edge === "start" ? selection.complete : selection.position
            return {
                update: ({clientX}: Dragging.Event): void => {
                    const pointerPulse = Math.max(0, snapping.xToUnitRound(localX(clientX)))
                    timeSelection.wrap({
                        ...selection,
                        position: Math.min(anchor, pointerPulse),
                        complete: Math.max(anchor, pointerPulse)
                    })
                },
                cancel: () => timeSelection.wrap(selection),
                finally: () => timeSelection.ifSome(({position, complete}) => {
                    if (complete <= position) {timeSelection.wrap(selection)}
                })
            }
        }
        const startMove = (selection: TimeSelection, event: PointerEvent): Dragging.Process => {
            const originPulse = snapping.xToUnitRound(localX(event.clientX))
            const timeRows = manager.timeRows()
            const covered = timeRows.flatMap(({key}, index) => selection.rows.hasKey(key) ? [index] : [])
            const first = covered.at(0) ?? 0
            const last = covered.at(-1) ?? 0
            const originRow = TimeSelection.rowIndexAt(timeRows, event.clientY)
            return {
                update: ({clientX, clientY}: Dragging.Event): void => {
                    const delta = Math.max(-selection.position,
                        snapping.xToUnitRound(localX(clientX)) - originPulse)
                    const rowDelta = selection.global ? 0
                        : clamp(TimeSelection.rowIndexAt(manager.timeRows(), clientY) - originRow,
                            -first, timeRows.length - 1 - last)
                    timeSelection.wrap({
                        ...selection,
                        position: selection.position + delta,
                        complete: selection.complete + delta,
                        rows: selection.global ? selection.rows : rowKeys(first + rowDelta, last + rowDelta)
                    })
                },
                cancel: () => timeSelection.wrap(selection)
            }
        }
        lifecycle.ownAll(
            Dragging.attach(element, (event: PointerEvent) => {
                const hit = hitTest(event.clientX, event.clientY)
                if (hit === "outside") {return Option.wrap(startCreate(event))}
                const selection = timeSelection.unwrap()
                return Option.wrap(hit === "inside" ? startMove(selection, event) : startResize(selection, hit))
            }),
            Events.subscribe(element, "pointermove", ({clientX, clientY, buttons}: PointerEvent) => {
                if (buttons !== 0) {return}
                const hit = hitTest(clientX, clientY)
                element.style.cursor = hit === "start" || hit === "complete" ? "ew-resize" : ""
            }),
            ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
                if (hitTest(client.clientX, client.clientY) === "outside") {return}
                addItems(
                    MenuItem.default({label: "Delete Time", shortcut: RegionsShortcuts["delete-time"].shortcut.format()})
                        .setTriggerProcedure(() => apply("delete")),
                    MenuItem.default({label: "Insert Time", shortcut: RegionsShortcuts["insert-time"].shortcut.format()})
                        .setTriggerProcedure(() => apply("insert")),
                    MenuItem.default({
                        label: "Remove Time Selection", separatorBefore: true,
                        shortcut: Shortcut.of(Key.Escape).format()
                    }).setTriggerProcedure(() => timeSelection.clear())
                )
            }),
            shortcuts.register(RegionsShortcuts["delete-time"].shortcut, () => {
                if (timeSelection.isEmpty()) {return false}
                apply("delete").then()
                return true
            }),
            shortcuts.register(RegionsShortcuts["insert-time"].shortcut, () => {
                if (timeSelection.isEmpty()) {return false}
                apply("insert").then()
                return true
            }),
            Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
                if (event.code === Key.Escape) {timeSelection.clear()}
            }),
            {terminate: () => element.style.cursor = ""}
        )
        return lifecycle
    }
}
