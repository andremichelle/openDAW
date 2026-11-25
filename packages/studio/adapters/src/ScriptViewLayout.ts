import {int, isDefined, Nullable, tryCatch} from "@opendaw/lib-std"
import {ScriptDeclaration, ViewDeclaration} from "./ScriptDeclaration"

const SECTION_LINE = /^\/\/ @(group|view)\b.*$/gm

export namespace ScriptViewLayout {
    export const ROWS = 3

    export type Area = {
        readonly column: int
        readonly row: int
        readonly columns: int
        readonly rows: int
    }

    export type Overlap = {
        readonly first: ViewDeclaration
        readonly second: ViewDeclaration
        readonly area: Area
    }

    export type Issue = {
        readonly offset: int
        readonly message: string
    }

    export const intersect = (first: Area, second: Area): Nullable<Area> => {
        const column = Math.max(first.column, second.column)
        const row = Math.max(first.row, second.row)
        const columnEnd = Math.min(first.column + first.columns, second.column + second.columns)
        const rowEnd = Math.min(first.row + first.rows, second.row + second.rows)
        return columnEnd > column && rowEnd > row ? {column, row, columns: columnEnd - column, rows: rowEnd - row} : null
    }

    export const overlaps = (views: ReadonlyArray<ViewDeclaration>): ReadonlyArray<Overlap> =>
        views.flatMap((first, index) => views.slice(index + 1).flatMap(second => {
            const area = intersect(first, second)
            return isDefined(area) ? [{first, second, area}] : []
        }))

    export const overflows = ({row, rows}: Area): boolean => row + rows - 1 > ROWS

    // the part of a view inside the three rows, `null` if none of it is
    export const visibleArea = (view: Area): Nullable<Area> =>
        view.row > ROWS ? null : {...view, rows: Math.min(view.rows, ROWS - view.row + 1)}

    // overlaps and overflows of every `@view` line, located at the line, for editor markers
    export const issues = (code: string): ReadonlyArray<Issue> => {
        const sections: Array<Array<{ offset: int, view: ViewDeclaration }>> = [[]]
        for (const match of code.matchAll(SECTION_LINE)) {
            if (match[1] === "group") {
                sections.push([])
                continue
            }
            const parsed = tryCatch(() => ScriptDeclaration.parseViews(match[0]))
            if (parsed.status === "failure" || parsed.value.length === 0) {continue}
            sections[sections.length - 1].push({offset: match.index, view: parsed.value[0]})
        }
        return sections.flatMap(entries => entries.flatMap(({offset, view}) => {
            const others = entries.filter(other => other.view !== view && isDefined(intersect(view, other.view)))
            const overlapIssues = others.map(other =>
                ({offset, message: `'${view.className}' overlaps '${other.view.className}'`}))
            const overflowIssues = overflows(view)
                ? [{offset, message: `'${view.className}' leaves the ${ROWS} rows (row ${view.row} + ${view.rows} rows)`}]
                : []
            return [...overlapIssues, ...overflowIssues]
        }))
    }
}
