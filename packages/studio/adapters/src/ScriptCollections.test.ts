import {describe, expect, it} from "vitest"
import {ScriptDeclaration} from "./ScriptDeclaration"

const parse = (...lines: ReadonlyArray<string>) => ScriptDeclaration.parseCollections(lines.join("\n"))

describe("ScriptDeclaration.parseCollections", () => {
    it("declares a counted collection with field defaults", () => {
        const [steps] = parse(
            "// @collection steps 3",
            "// @field steps.on        true",
            "// @field steps.velocity  0.8   0    1   linear",
            "// @field steps.transpose 0    -12  12   int  st"
        )
        expect(steps.name).toBe("steps")
        expect(steps.index).toBe(0)
        expect(steps.fields.map(({label, mapping, min, max, unit}) => [label, mapping, min, max, unit])).toEqual([
            ["on", "bool", 0, 1, ""], ["velocity", "linear", 0, 1, ""], ["transpose", "int", -12, 12, "st"]
        ])
        expect(steps.records).toEqual([[1, 0.8, 0], [1, 0.8, 0], [1, 0.8, 0]])
    })
    it("seeds records from @record lines, unnamed fields take their default", () => {
        const [partials] = parse(
            "// @collection partials",
            "// @field partials.level 0 0 1 linear",
            "// @field partials.phase 0.5",
            "// @record partials level=1",
            "// @record partials level=0.5 phase=0",
            "// @record partials"
        )
        expect(partials.records).toEqual([[1, 0.5], [0.5, 0], [0, 0.5]])
    })
    it("accepts true and false in records", () => {
        const [steps] = parse("// @collection steps", "// @field steps.on true", "// @record steps on=false")
        expect(steps.records).toEqual([[0]])
    })
    it("is empty without count and records", () => {
        expect(parse("// @collection empty", "// @field empty.value 0")[0].records).toEqual([])
    })
    it("indexes collections in declaration order", () => {
        expect(parse("// @collection first", "// @collection second").map(({name, index}) => `${name}:${index}`))
            .toEqual(["first:0", "second:1"])
    })
    it("rejects malformed declarations", () => {
        expect(() => parse("// @collection")).toThrow("Malformed @collection")
        expect(() => parse("// @collection steps many")).toThrow("Malformed @collection")
        expect(() => parse("// @collection steps", "// @collection steps")).toThrow("Duplicate @collection 'steps'")
        expect(() => parse("// @field steps.on true")).toThrow("no '// @collection steps' declared")
        expect(() => parse("// @collection steps", "// @field steps true")).toThrow("Malformed @field")
        expect(() => parse("// @collection steps", "// @field steps.a.b true")).toThrow("Malformed @field")
        expect(() => parse("// @collection steps", "// @field steps.on 2 0 1 linear")).toThrow(/Malformed @field: '\/\/ @field steps.on 2 0 1 linear' — default/)
        expect(() => parse("// @collection steps", "// @field steps.on true", "// @field steps.on false")).toThrow("Duplicate @field 'steps.on'")
        expect(() => parse("// @collection steps 4", "// @field steps.on true", "// @record steps on=1")).toThrow("count AND @record")
        expect(() => parse("// @collection steps", "// @field steps.on true", "// @record steps off=1")).toThrow("no @field 'steps.off'")
        expect(() => parse("// @collection steps", "// @field steps.v 0 0 1 linear", "// @record steps v=2")).toThrow("v=2 is not a number in [0, 1]")
        expect(() => parse("// @collection steps", "// @field steps.v 0", "// @record steps v")).toThrow("is not field=value")
        expect(() => parse("// @collection __proto__")).toThrow("Reserved name")
        expect(() => parse("// @record ghost")).toThrow("no '// @collection ghost' declared")
    })
    it("ignores lines that only start with the tag", () => {
        expect(parse("// @collections 1", "// @fields x", "// @recordings y")).toEqual([])
    })
})
