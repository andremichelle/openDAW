import {clamp, Terminable, UUID} from "@opendaw/lib-std"
import {TimeSelection} from "@/ui/timeline/TimeSelection"
import {TimeSelectionActions} from "@/ui/timeline/TimeSelectionActions"
import {TimeSelectionGestures} from "@/ui/timeline/TimeSelectionGestures"
import {RegionsToolContext} from "@/ui/timeline/tracks/audio-unit/regions/RegionsToolContext"

export namespace TimeSelectionTool {
    export const install = ({service, manager, range, element, shortcuts}: RegionsToolContext): Terminable => {
        const {project, timeline: {snapping, timeSelection}} = service
        const rowKeys = (from: number, to: number): TimeSelection["rows"] => {
            const rows = UUID.newSet<UUID.Bytes>(uuid => uuid)
            manager.timeRows().slice(Math.min(from, to), Math.max(from, to) + 1).forEach(({key}) => rows.add(key))
            return rows
        }
        const span = ({rows}: TimeSelection): [number, number] => {
            const timeRows = manager.timeRows()
            return [timeRows.findIndex(({key}) => rows.hasKey(key)), timeRows.findLastIndex(({key}) => rows.hasKey(key))]
        }
        const rowAt = (clientY: number): number => TimeSelection.rowIndexAt(manager.timeRows(), clientY)
        return TimeSelectionGestures.install({
            element, range, snapping, shortcuts, timeSelection,
            owns: () => true,
            originAt: rowAt,
            covers: (selection, clientY) => {
                if (selection.global) {return true}
                const [first, last] = span(selection)
                const index = rowAt(clientY)
                return first !== -1 && index >= first && index <= last
            },
            scopeAt: (origin, clientY, shiftKey) => ({rows: rowKeys(origin, rowAt(clientY)), global: shiftKey}),
            moveRows: (selection, origin, clientY) => {
                if (selection.global) {return selection.rows}
                const [first, last] = span(selection)
                if (first === -1) {return selection.rows}
                const delta = clamp(rowAt(clientY) - origin, -first, manager.timeRows().length - 1 - last)
                return rowKeys(first + delta, last + delta)
            },
            apply: (selection, action) => TimeSelectionActions.apply(service, selection,
                selection.global ? TimeSelectionActions.allTracks(project) : manager.timeTracks(selection), action)
        })
    }
}
