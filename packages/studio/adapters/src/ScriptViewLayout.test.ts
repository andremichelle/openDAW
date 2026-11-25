import {describe, expect, it} from "vitest"
import {ScriptDeclaration} from "./ScriptDeclaration"
import {ScriptViewLayout} from "./ScriptViewLayout"

describe("ScriptDeclaration views and windows", () => {
    it("parses views with and without a class name", () => {
        expect(ScriptDeclaration.parseViews("// @view 2 1 8 3\n// @view PatternView 3 1 8 2 // the grid")).toEqual([
            {className: "View", column: 2, row: 1, columns: 8, rows: 3},
            {className: "PatternView", column: 3, row: 1, columns: 8, rows: 2}
        ])
    })
    it("parses windows with and without a class name", () => {
        expect(ScriptDeclaration.parseWindows("// @window 900 520\n// @window EditorView 640 480")).toEqual([
            {className: "View", width: 900, height: 520},
            {className: "EditorView", width: 640, height: 480}
        ])
    })
    it("rejects malformed views and windows", () => {
        expect(() => ScriptDeclaration.parseViews("// @view 1 1 8")).toThrow("expected: // @view [Class] <column> <row> <columns> <rows>")
        expect(() => ScriptDeclaration.parseViews("// @view 0 1 8 3")).toThrow("Malformed @view")
        expect(() => ScriptDeclaration.parseViews("// @view 1 1 2.5 3")).toThrow("Malformed @view")
        expect(() => ScriptDeclaration.parseViews("// @view my-view 1 1 2 3")).toThrow("is not a class name")
        expect(() => ScriptDeclaration.parseViews("// @view __proto__ 1 1 2 3")).toThrow("Reserved name")
        expect(() => ScriptDeclaration.parseWindows("// @window EditorView 640")).toThrow("expected: // @window [Class] <width> <height>")
    })
    it("ignores lines that only start with the tag", () => {
        expect(ScriptDeclaration.parseViews("// @viewport 1 1 1 1")).toEqual([])
    })
    it("places views into their section in directive order", () => {
        const sections = ScriptDeclaration.parseGroups([
            "// @param gain 1",
            "// @view 2 1 4 3",
            "// @group Tone blue",
            "// @param cutoff 1000 20 20000 exp Hz",
            "// @view ScopeView 1 2 3 2"
        ].join("\n"))
        expect(sections.map(section => section.items.map(item => item.type))).toEqual([["param", "view"], ["param", "view"]])
        expect(sections[1].items[1]).toEqual({type: "view", declaration: {className: "ScopeView", column: 1, row: 2, columns: 3, rows: 2}})
    })
})

describe("ScriptViewLayout", () => {
    const view = (column: number, row: number, columns: number, rows: number, className: string = "View") =>
        ({className, column, row, columns, rows})
    it("intersects areas", () => {
        expect(ScriptViewLayout.intersect(view(1, 1, 4, 2), view(3, 2, 4, 2))).toEqual({column: 3, row: 2, columns: 2, rows: 1})
        expect(ScriptViewLayout.intersect(view(1, 1, 2, 3), view(3, 1, 2, 3))).toBeNull()
        expect(ScriptViewLayout.intersect(view(1, 1, 2, 1), view(1, 2, 2, 1))).toBeNull()
        expect(ScriptViewLayout.intersect(view(1, 1, 8, 3), view(2, 2, 1, 1))).toEqual({column: 2, row: 2, columns: 1, rows: 1})
    })
    it("lists every overlapping pair", () => {
        const first = view(1, 1, 4, 3, "A"), second = view(3, 1, 4, 1, "B"), third = view(6, 1, 2, 3, "C")
        expect(ScriptViewLayout.overlaps([first, second, third]).map(({first, second, area}) =>
            `${first.className}${second.className}:${area.column},${area.row},${area.columns},${area.rows}`))
            .toEqual(["AB:3,1,2,1", "BC:6,1,1,1"])
    })
    it("detects and clips overflowing views", () => {
        expect(ScriptViewLayout.overflows(view(1, 2, 2, 2))).toBe(false)
        expect(ScriptViewLayout.overflows(view(1, 2, 2, 3))).toBe(true)
        expect(ScriptViewLayout.visibleArea(view(1, 2, 2, 3))).toEqual(view(1, 2, 2, 2))
        expect(ScriptViewLayout.visibleArea(view(1, 4, 2, 1))).toBeNull()
    })
    it("reports issues at the @view lines, per section", () => {
        const code = [
            "// @view PatternView 2 1 8 2",
            "// @view ScopeView 2 2 4 2",
            "// @group Tone",
            "// @view Other 2 1 8 2",
            "// @view Tall 12 2 1 3"
        ].join("\n")
        const issues = ScriptViewLayout.issues(code).map(({offset, message}) => `${code.slice(offset).split("\n")[0]} | ${message}`)
        expect(issues).toEqual([
            "// @view PatternView 2 1 8 2 | 'PatternView' overlaps 'ScopeView'",
            "// @view ScopeView 2 2 4 2 | 'ScopeView' overlaps 'PatternView'",
            "// @view Tall 12 2 1 3 | 'Tall' leaves the 3 rows (row 2 + 3 rows)"
        ])
    })
    it("skips malformed lines instead of throwing", () => {
        expect(ScriptViewLayout.issues("// @view 1 1\n// @view 1 1 2 3")).toEqual([])
    })
})
