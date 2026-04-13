import {describe, expect, it} from "vitest"
import {ScriptDeclaration} from "./ScriptDeclaration"

describe("ScriptDeclaration", () => {
    describe("parseLabel", () => {
        it("parses a label", () => {
            expect(ScriptDeclaration.parseLabel("// @label MyDevice").unwrap()).toBe("MyDevice")
        })
        it("returns None when no label", () => {
            expect(ScriptDeclaration.parseLabel("// no label here").isEmpty()).toBe(true)
        })
        it("returns None on empty label", () => {
            expect(ScriptDeclaration.parseLabel("// @label ").isEmpty()).toBe(true)
        })
    })

    describe("parseParams", () => {
        it("parses unipolar param with no args", () => {
            const params = ScriptDeclaration.parseParams("// @param gain")
            expect(params).toEqual([{label: "gain", defaultValue: 0, min: 0, max: 1, mapping: "unipolar", unit: ""}])
        })
        it("parses param with default value", () => {
            const params = ScriptDeclaration.parseParams("// @param volume 0.8")
            expect(params[0].label).toBe("volume")
            expect(params[0].defaultValue).toBe(0.8)
        })
        it("parses bool param from keyword", () => {
            const params = ScriptDeclaration.parseParams("// @param enabled true")
            expect(params[0]).toEqual({label: "enabled", defaultValue: 1, min: 0, max: 1, mapping: "bool", unit: ""})
        })
        it("parses bool param from mapping", () => {
            const params = ScriptDeclaration.parseParams("// @param active bool")
            expect(params[0].mapping).toBe("bool")
        })
        it("parses linear param with min/max", () => {
            const params = ScriptDeclaration.parseParams("// @param freq 440 20 20000")
            expect(params[0]).toEqual({label: "freq", defaultValue: 440, min: 20, max: 20000, mapping: "linear", unit: ""})
        })
        it("parses param with mapping and unit", () => {
            const params = ScriptDeclaration.parseParams("// @param cutoff 1000 20 20000 exp Hz")
            expect(params[0]).toEqual({label: "cutoff", defaultValue: 1000, min: 20, max: 20000, mapping: "exp", unit: "Hz"})
        })
        it("parses integer param", () => {
            const params = ScriptDeclaration.parseParams("// @param steps 4 1 16 int")
            expect(params[0].mapping).toBe("int")
            expect(params[0].min).toBe(1)
            expect(params[0].max).toBe(16)
        })
        it("parses multiple params", () => {
            const code = "// @param attack 0.01 0 1 exp s\n// @param decay 0.2 0 2 exp s"
            const params = ScriptDeclaration.parseParams(code)
            expect(params.length).toBe(2)
            expect(params[0].label).toBe("attack")
            expect(params[1].label).toBe("decay")
        })
        it("throws on default out of range", () => {
            expect(() => ScriptDeclaration.parseParams("// @param x 100 0 1 linear")).toThrow()
        })
        it("throws on min >= max", () => {
            expect(() => ScriptDeclaration.parseParams("// @param x 5 10 10 linear")).toThrow()
        })
        it("throws on unknown mapping", () => {
            expect(() => ScriptDeclaration.parseParams("// @param x 0.5 0 1 cubic")).toThrow()
        })
    })

    describe("parseSamples", () => {
        it("parses a single sample", () => {
            expect(ScriptDeclaration.parseSamples("// @sample kick")).toEqual([{label: "kick"}])
        })
        it("parses multiple samples", () => {
            const samples = ScriptDeclaration.parseSamples("// @sample kick\n// @sample snare")
            expect(samples.length).toBe(2)
            expect(samples[0].label).toBe("kick")
            expect(samples[1].label).toBe("snare")
        })
        it("ignores sample line with no name", () => {
            expect(ScriptDeclaration.parseSamples("// @sample ")).toEqual([])
        })
    })

    describe("parseDeclarationOrder", () => {
        it("assigns sequential indices", () => {
            const code = "// @param attack\n// @sample kick\n// @param decay"
            const order = ScriptDeclaration.parseDeclarationOrder(code)
            expect(order.get("attack")).toBe(0)
            expect(order.get("kick")).toBe(1)
            expect(order.get("decay")).toBe(2)
        })
        it("keeps first index for duplicate labels", () => {
            const code = "// @param gain\n// @param gain"
            const order = ScriptDeclaration.parseDeclarationOrder(code)
            expect(order.get("gain")).toBe(0)
            expect(order.size).toBe(1)
        })
    })

    describe("parseGroups", () => {
        const paramItems = (section: { items: ReadonlyArray<{ type: string }> }) =>
            section.items.filter(item => item.type === "param")
        const sampleItems = (section: { items: ReadonlyArray<{ type: string }> }) =>
            section.items.filter(item => item.type === "sample")
        it("returns single ungrouped section for params without @group", () => {
            const code = "// @param gain\n// @param volume 0.5"
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(1)
            expect(sections[0].group).toBeNull()
            expect(sections[0].items.length).toBe(2)
        })
        it("returns empty array for code with no declarations", () => {
            expect(ScriptDeclaration.parseGroups("const x = 1")).toEqual([])
        })
        it("parses a single group", () => {
            const code = "// @group Envelope green\n// @param attack 0.01 0 1 exp s\n// @param decay 0.2 0 2 exp s"
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(1)
            expect(sections[0].group).toEqual({label: "Envelope", color: "green"})
            expect(sections[0].items.length).toBe(2)
            expect(sections[0].items[0].declaration.label).toBe("attack")
            expect(sections[0].items[1].declaration.label).toBe("decay")
        })
        it("parses multiple groups", () => {
            const code = [
                "// @group Envelope green",
                "// @param attack 0.01 0 1 exp s",
                "// @param release 0.5 0 5 exp s",
                "// @group Filter blue",
                "// @param cutoff 1000 20 20000 exp Hz"
            ].join("\n")
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(2)
            expect(sections[0].group).toEqual({label: "Envelope", color: "green"})
            expect(sections[0].items.length).toBe(2)
            expect(sections[1].group).toEqual({label: "Filter", color: "blue"})
            expect(sections[1].items.length).toBe(1)
        })
        it("handles ungrouped params before first group", () => {
            const code = [
                "// @param gain",
                "// @group Envelope green",
                "// @param attack 0.01 0 1 exp s"
            ].join("\n")
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(2)
            expect(sections[0].group).toBeNull()
            expect(sections[0].items.length).toBe(1)
            expect(sections[0].items[0].declaration.label).toBe("gain")
            expect(sections[1].group).toEqual({label: "Envelope", color: "green"})
            expect(sections[1].items.length).toBe(1)
        })
        it("defaults color to 'dark' when omitted", () => {
            const code = "// @group Envelope\n// @param attack"
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections[0].group).toEqual({label: "Envelope", color: "dark"})
        })
        it("includes samples in groups and preserves declaration order", () => {
            const code = [
                "// @group Drums orange",
                "// @sample kick",
                "// @param volume",
                "// @sample snare"
            ].join("\n")
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(1)
            expect(sections[0].items.length).toBe(3)
            expect(sections[0].items[0]).toEqual({type: "sample", declaration: {label: "kick"}})
            expect(sections[0].items[1].type).toBe("param")
            expect(sections[0].items[2]).toEqual({type: "sample", declaration: {label: "snare"}})
        })
        it("handles empty group followed by group with content", () => {
            const code = [
                "// @group Empty red",
                "// @group Full green",
                "// @param attack"
            ].join("\n")
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(2)
            expect(sections[0].group).toEqual({label: "Empty", color: "red"})
            expect(sections[0].items.length).toBe(0)
            expect(sections[1].group).toEqual({label: "Full", color: "green"})
            expect(sections[1].items.length).toBe(1)
        })
        it("creates section for trailing empty group", () => {
            const code = "// @param gain\n// @group Tail purple"
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(2)
            expect(sections[0].group).toBeNull()
            expect(sections[1].group).toEqual({label: "Tail", color: "purple"})
            expect(sections[1].items.length).toBe(0)
        })
        it("mixed params and samples across groups", () => {
            const code = [
                "// @sample global_ir",
                "// @group Synth blue",
                "// @param cutoff 1000 20 20000 exp Hz",
                "// @sample wavetable",
                "// @group Output cream",
                "// @param volume 0.8"
            ].join("\n")
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(3)
            expect(sections[0].group).toBeNull()
            expect(sampleItems(sections[0]).length).toBe(1)
            expect(paramItems(sections[0]).length).toBe(0)
            expect(sections[1].group).toEqual({label: "Synth", color: "blue"})
            expect(paramItems(sections[1]).length).toBe(1)
            expect(sampleItems(sections[1]).length).toBe(1)
            expect(sections[2].group).toEqual({label: "Output", color: "cream"})
            expect(paramItems(sections[2]).length).toBe(1)
            expect(sampleItems(sections[2]).length).toBe(0)
        })
        it("is idempotent (global regex lastIndex reset)", () => {
            const code = [
                "// @group Envelope green",
                "// @param attack 0.01 0 1 exp s",
                "// @param decay 0.2 0 2 exp s",
                "// @group Filter blue",
                "// @param cutoff 1000 20 20000 exp Hz"
            ].join("\n")
            const first = ScriptDeclaration.parseGroups(code)
            const second = ScriptDeclaration.parseGroups(code)
            expect(first.length).toBe(second.length)
            for (let index = 0; index < first.length; index++) {
                expect(first[index].group).toEqual(second[index].group)
                expect(first[index].items.length).toBe(second[index].items.length)
            }
        })
        it("parses grain synthesizer style code with groups and many params", () => {
            const code = [
                "// @label GrainSynth",
                "// @group Grain green",
                "// @param grainSize 50 1 500 exp ms",
                "// @param density 10 1 100 exp",
                "// @param spread 0.5",
                "// @param pitch 0 -24 24 int st",
                "// @group Envelope blue",
                "// @param attack 0.01 0 1 exp s",
                "// @param decay 0.2 0 2 exp s",
                "// @param sustain 0.7",
                "// @param release 0.5 0 5 exp s",
                "// @group Output orange",
                "// @param volume 0.8",
                "// @param pan 0 -1 1 linear",
                "// @sample wavetable"
            ].join("\n")
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(3)
            expect(sections[0].group).toEqual({label: "Grain", color: "green"})
            expect(paramItems(sections[0]).length).toBe(4)
            expect(sections[0].items[0].declaration.label).toBe("grainSize")
            expect(sections[1].group).toEqual({label: "Envelope", color: "blue"})
            expect(paramItems(sections[1]).length).toBe(4)
            expect(sections[2].group).toEqual({label: "Output", color: "orange"})
            expect(paramItems(sections[2]).length).toBe(2)
            expect(sampleItems(sections[2]).length).toBe(1)
            expect(sections[2].items[2].declaration.label).toBe("wavetable")
        })
    })

    describe("isEqual", () => {
        it("returns true for identical declarations", () => {
            const decl = {label: "x", defaultValue: 0.5, min: 0, max: 1, mapping: "linear" as const, unit: ""}
            expect(ScriptDeclaration.isEqual(decl, decl)).toBe(true)
        })
        it("returns false when default differs", () => {
            const base = {label: "x", defaultValue: 0.5, min: 0, max: 1, mapping: "linear" as const, unit: ""}
            expect(ScriptDeclaration.isEqual(base, {...base, defaultValue: 0.6})).toBe(false)
        })
        it("returns false when mapping differs", () => {
            const base = {label: "x", defaultValue: 0.5, min: 0, max: 1, mapping: "linear" as const, unit: ""}
            expect(ScriptDeclaration.isEqual(base, {...base, mapping: "exp" as const})).toBe(false)
        })
    })
})
