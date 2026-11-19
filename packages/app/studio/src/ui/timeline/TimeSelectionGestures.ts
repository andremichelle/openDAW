import {Func, MutableObservableOption, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {Dragging, Events, Key, ShortcutContext} from "@opendaw/lib-dom"
import {ContextMenu, TimelineRange} from "@opendaw/studio-core"
import {Snapping} from "@/ui/timeline/Snapping"
import {TimeSelection} from "@/ui/timeline/TimeSelection"
import {TimeSelectionActions} from "@/ui/timeline/TimeSelectionActions"
import {TimeSelectionShortcuts} from "@/ui/shortcuts/TimeSelectionShortcuts"

export namespace TimeSelectionGestures {
    export type Hit = "outside" | "inside" | "start" | "complete"

    export type Scope = Readonly<{rows: TimeSelection["rows"], global: boolean}>

    export type Construct = Readonly<{
        element: HTMLElement
        range: TimelineRange
        snapping: Snapping
        shortcuts: ShortcutContext
        timeSelection: MutableObservableOption<TimeSelection>
        owns: (selection: TimeSelection) => boolean
        covers: (selection: TimeSelection, clientY: number) => boolean
        originAt: (clientY: number) => number
        scopeAt: (origin: number, clientY: number, shiftKey: boolean) => Scope
        moveRows: (selection: TimeSelection, origin: number, clientY: number) => TimeSelection["rows"]
        scope: (selection: TimeSelection) => TimeSelectionActions.Scope
        apply: (selection: TimeSelection, scope: TimeSelectionActions.Scope, action: TimeSelectionActions.Action) => void
    }>

    const EdgeRadius = 4

    export const install = ({
                                element, range, snapping, shortcuts, timeSelection, owns, covers, originAt, scopeAt, moveRows, scope, apply
                            }: Construct): Terminable => {
        const lifecycle = new Terminator()
        const localX = (clientX: number): number => clientX - element.getBoundingClientRect().left
        const pulseAt = (clientX: number): ppqn => Math.max(0, snapping.xToUnitRound(localX(clientX)))
        const hitTest = (clientX: number, clientY: number): Hit => timeSelection.match({
            none: (): Hit => "outside",
            some: (selection): Hit => {
                if (!covers(selection, clientY)) {return "outside"}
                const x = localX(clientX)
                const x0 = range.unitToX(selection.position)
                const x1 = range.unitToX(selection.complete)
                if (Math.abs(x - x0) <= EdgeRadius) {return "start"}
                if (Math.abs(x - x1) <= EdgeRadius) {return "complete"}
                return x0 < x && x < x1 ? "inside" : "outside"
            }
        })
        const sameRows = (a: TimeSelection["rows"], b: TimeSelection["rows"]): boolean =>
            a.size() === b.size() && a.values().every(key => b.hasKey(key))
        const wrapIfChanged = (next: TimeSelection): void => {
            const unchanged = timeSelection.match({
                none: () => false,
                some: ({position, complete, global, rows}) => position === next.position && complete === next.complete
                    && global === next.global && sameRows(rows, next.rows)
            })
            if (!unchanged) {timeSelection.wrap(next)}
        }
        const run = (action: TimeSelectionActions.Action): boolean => timeSelection.match({
            none: () => false,
            some: selection => {
                if (!owns(selection)) {return false}
                apply(selection, scope(selection), action)
                return true
            }
        })
        const startCreate = (event: PointerEvent): Dragging.Process => {
            const previous = timeSelection.unwrapOrNull()
            const origin = pulseAt(event.clientX)
            const originRow = originAt(event.clientY)
            const update = ({clientX, clientY, shiftKey}: Dragging.Event): void => {
                const pointerPulse = pulseAt(clientX)
                wrapIfChanged({
                    ...scopeAt(originRow, clientY, shiftKey),
                    position: Math.min(origin, pointerPulse), complete: Math.max(origin, pointerPulse)
                })
            }
            update(event)
            return {
                update,
                cancel: () => timeSelection.wrap(previous),
                finally: () => timeSelection.ifSome(({position, complete}) => {
                    if (complete <= position) {timeSelection.clear()}
                })
            }
        }
        const startResize = (selection: TimeSelection, edge: "start" | "complete"): Dragging.Process => {
            const anchor: ppqn = edge === "start" ? selection.complete : selection.position
            return {
                update: ({clientX}: Dragging.Event): void => {
                    const pointerPulse = pulseAt(clientX)
                    wrapIfChanged({...selection, position: Math.min(anchor, pointerPulse), complete: Math.max(anchor, pointerPulse)})
                },
                cancel: () => timeSelection.wrap(selection),
                finally: () => timeSelection.ifSome(({position, complete}) => {
                    if (complete <= position) {timeSelection.wrap(selection)}
                })
            }
        }
        const startMove = (selection: TimeSelection, event: PointerEvent): Dragging.Process => {
            const originPulse = snapping.xToUnitRound(localX(event.clientX))
            const originRow = originAt(event.clientY)
            return {
                update: ({clientX, clientY}: Dragging.Event): void => {
                    const delta = Math.max(-selection.position, snapping.xToUnitRound(localX(clientX)) - originPulse)
                    wrapIfChanged({
                        ...selection, rows: moveRows(selection, originRow, clientY),
                        position: selection.position + delta, complete: selection.complete + delta
                    })
                },
                cancel: () => timeSelection.wrap(selection)
            }
        }
        const factory: Func<PointerEvent, Option<Dragging.Process>> = (event: PointerEvent) => {
            const hit = hitTest(event.clientX, event.clientY)
            if (hit === "outside") {return Option.wrap(startCreate(event))}
            const selection = timeSelection.unwrap()
            return Option.wrap(hit === "inside" ? startMove(selection, event) : startResize(selection, hit))
        }
        lifecycle.ownAll(
            Dragging.attach(element, factory, {permanentUpdates: true}),
            Events.subscribe(element, "pointermove", ({clientX, clientY, buttons}: PointerEvent) => {
                if (buttons !== 0) {return}
                const hit = hitTest(clientX, clientY)
                element.style.cursor = hit === "start" || hit === "complete" ? "ew-resize" : ""
            }),
            ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
                if (hitTest(client.clientX, client.clientY) === "outside") {return}
                timeSelection.ifSome(selection =>
                    addItems(...TimeSelectionActions.menuItems(scope(selection), action => run(action))))
            }),
            shortcuts.register(TimeSelectionShortcuts["delete-time"].shortcut, () => run("delete")),
            shortcuts.register(TimeSelectionShortcuts["insert-time"].shortcut, () => run("insert")),
            shortcuts.register(TimeSelectionShortcuts["insert-region"].shortcut, () => run("insert-region")),
            Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
                if (event.code === Key.Escape) {timeSelection.clear()}
            }),
            {terminate: () => element.style.cursor = ""}
        )
        return lifecycle
    }
}
