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

    describe("parsePassThrough", () => {
        it("passes through when the directive is absent", () => {
            expect(ScriptDeclaration.parsePassThrough("class Processor {}")).toBe(true)
        })
        it("suppresses pass-through on @no-pass", () => {
            expect(ScriptDeclaration.parsePassThrough("// @no-pass\nclass Processor {}")).toBe(false)
        })
        it("finds the directive anywhere in the code", () => {
            const code = ["// @label Chords", "// @param mode 0 0 3 int", "// @no-pass", "class Processor {}"].join("\n")
            expect(ScriptDeclaration.parsePassThrough(code)).toBe(false)
        })
        it("tolerates trailing whitespace", () => {
            expect(ScriptDeclaration.parsePassThrough("// @no-pass   \nclass Processor {}")).toBe(false)
        })
        it("ignores the directive mid-line", () => {
            expect(ScriptDeclaration.parsePassThrough("const text = \"// @no-pass\"")).toBe(true)
        })
        it("throws on trailing tokens", () => {
            expect(() => ScriptDeclaration.parsePassThrough("// @no-pass please")).toThrow()
        })
    })

    describe("parseLatency", () => {
        it("is 0 without the directive", () => {
            expect(ScriptDeclaration.parseLatency("class Processor {}")).toBe(0)
        })
        it("reads milliseconds", () => {
            expect(ScriptDeclaration.parseLatency("// @latency 21.3\nclass Processor {}")).toBe(21.3)
        })
        it("allows a trailing comment", () => {
            expect(ScriptDeclaration.parseLatency("// @latency 5 // look-ahead")).toBe(5)
        })
        it("ignores the directive mid-line", () => {
            expect(ScriptDeclaration.parseLatency("const text = \"// @latency 5\"")).toBe(0)
        })
        it("throws on a missing, negative or non-numeric value", () => {
            expect(() => ScriptDeclaration.parseLatency("// @latency")).toThrow()
            expect(() => ScriptDeclaration.parseLatency("// @latency -1")).toThrow()
            expect(() => ScriptDeclaration.parseLatency("// @latency fast")).toThrow()
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
        it("accepts names starting with a digit or hash", () => {
            expect(ScriptDeclaration.parseParams("// @param 1 5 1 9 int")[0].label).toBe("1")
            expect(ScriptDeclaration.parseParams("// @param #steps 0.5")[0].label).toBe("#steps")
            expect(ScriptDeclaration.parseParams("// @param foo-bar 0.5")[0].label).toBe("foo-bar")
        })
    })

    describe("[omit-default-ui]", () => {
        const parse = (line: string) => ScriptDeclaration.parseParams(line)[0]
        it("is absent on every existing form", () => {
            expect(parse("// @param gain").omitDefaultUi).toBeUndefined()
            expect(parse("// @param cutoff 1000 20 20000 exp Hz").omitDefaultUi).toBeUndefined()
        })
        it("is accepted after every form and leaves the declaration unchanged", () => {
            const forms = ["gain", "gain 0.5", "bypass true", "bypass bool", "level 0.4 bool", "freq 440 20 20000",
                "mode 0 0 3 int", "time 500 1 2000 linear", "cutoff 1000 20 20000 exp Hz"]
            for (const form of forms) {
                expect(parse(`// @param ${form} [omit-default-ui]`)).toEqual({...parse(`// @param ${form}`), omitDefaultUi: true})
            }
        })
        it("is accepted between tokens and before a trailing comment", () => {
            expect(parse("// @param cutoff [omit-default-ui] 1000 20 20000 exp Hz"))
                .toEqual({label: "cutoff", defaultValue: 1000, min: 20, max: 20000, mapping: "exp", unit: "Hz", omitDefaultUi: true})
            expect(parse("// @param cutoff 1000 20 20000 exp Hz [omit-default-ui]   // the view draws it").omitDefaultUi).toBe(true)
        })
        it("is never read as the unit", () => {
            expect(parse("// @param cutoff 1000 20 20000 exp [omit-default-ui]").unit).toBe("")
        })
        it("rejects unknown flags", () => {
            expect(() => parse("// @param gain 0.5 [hide]")).toThrow("unknown flag '[hide]'")
            expect(() => parse("// @param gain 0.5 [omit-default-ui"))
                .toThrow("unknown flag '[omit-default-ui'")
        })
        it("still validates the positional tokens", () => {
            expect(() => parse("// @param x 0.5 0 1 cubic [omit-default-ui]")).toThrow("unknown mapping 'cubic'")
            expect(() => parse("// @param x 5 0 1 linear [omit-default-ui]")).toThrow("must be within")
        })
        it("travels into parseGroups", () => {
            const [section] = ScriptDeclaration.parseGroups("// @param a 0.5\n// @param b 0.5 [omit-default-ui]")
            expect(section.items.map(item => item.type === "param" && item.declaration.omitDefaultUi === true)).toEqual([false, true])
        })
        it("keeps the declaration equal, so toggling it keeps the parameter box", () => {
            expect(ScriptDeclaration.isEqual(parse("// @param a 0.5 0 1 linear"), parse("// @param a 0.5 0 1 linear [omit-default-ui]")))
                .toBe(true)
        })
        it("is rejected on @field", () => {
            expect(() => ScriptDeclaration.parseCollections("// @collection steps\n// @field steps.on true [omit-default-ui]"))
                .toThrow("only applies to @param")
        })
        it("does not change the declaration order", () => {
            expect([...ScriptDeclaration.parseDeclarationOrder("// @param a [omit-default-ui]\n// @param b").entries()])
                .toEqual([["a", 0], ["b", 1]])
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
        it("accepts a sample name starting with a digit", () => {
            expect(ScriptDeclaration.parseSamples("// @sample 1kick")).toEqual([{label: "1kick"}])
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

    describe("parseSidechains", () => {
        it("parses sidechains in line order", () => {
            const code = "// @sidechain Key\n// @param gain\n// @sidechain Modulator"
            expect(ScriptDeclaration.parseSidechains(code)).toEqual([{label: "Key"}, {label: "Modulator"}])
        })
        it("returns an empty list without @sidechain", () => {
            expect(ScriptDeclaration.parseSidechains("// @param gain\n// @sample kick")).toEqual([])
        })
        it("keeps the first of duplicate names", () => {
            expect(ScriptDeclaration.parseSidechains("// @sidechain A\n// @sidechain B\n// @sidechain A"))
                .toEqual([{label: "A"}, {label: "B"}])
        })
        it("ignores a trailing comment", () => {
            expect(ScriptDeclaration.parseSidechains("// @sidechain Key // the kick")).toEqual([{label: "Key"}])
        })
        it("throws on extra tokens", () => {
            expect(() => ScriptDeclaration.parseSidechains("// @sidechain Key Extra")).toThrow()
        })
        it("does not match without a name or a space", () => {
            expect(ScriptDeclaration.parseSidechains("// @sidechain\n// @sidechainKey")).toEqual([])
        })
        it("supports many sidechains", () => {
            const code = Array.from({length: 32}, (_, index) => `// @sidechain S${index}`).join("\n")
            expect(ScriptDeclaration.parseSidechains(code).length).toBe(32)
        })
        it("leaves the param and sample declaration order untouched", () => {
            const code = "// @param attack\n// @sidechain Key\n// @sample kick\n// @sidechain Other\n// @param decay"
            const order = ScriptDeclaration.parseDeclarationOrder(code)
            expect(order.get("attack")).toBe(0)
            expect(order.get("kick")).toBe(1)
            expect(order.get("decay")).toBe(2)
            expect(order.has("Key")).toBe(false)
            expect(order.size).toBe(3)
        })
        it("parseGroups emits sidechain items in place", () => {
            const code = "// @param gain\n// @group Inputs orange\n// @sidechain A\n// @param mixA\n// @sidechain B"
            const sections = ScriptDeclaration.parseGroups(code)
            expect(sections.length).toBe(2)
            expect(sections[0].items.map(item => item.type)).toEqual(["param"])
            expect(sections[1].group).toEqual({label: "Inputs", color: "orange"})
            expect(sections[1].items.map(item => `${item.type}:${item.declaration.label}`))
                .toEqual(["sidechain:A", "param:mixA", "sidechain:B"])
        })
        it("parseGroups is unchanged for scripts without @sidechain", () => {
            const code = "// @group G blue\n// @param a\n// @sample s"
            expect(ScriptDeclaration.parseGroups(code)[0].items.map(item => item.type)).toEqual(["param", "sample"])
        })
    })

    describe("reserved names", () => {
        it("rejects __proto__ as a @param, @sample or @sidechain name", () => {
            expect(() => ScriptDeclaration.parseParams("// @param __proto__ 0.5")).toThrow("Reserved name '__proto__'")
            expect(() => ScriptDeclaration.parseSamples("// @sample __proto__")).toThrow("Reserved name '__proto__'")
            expect(() => ScriptDeclaration.parseSidechains("// @sidechain __proto__")).toThrow("Reserved name '__proto__'")
            expect(() => ScriptDeclaration.parseGroups("// @sample __proto__")).toThrow("Reserved name '__proto__'")
        })
        it("accepts names that merely contain proto", () => {
            expect(ScriptDeclaration.parseSidechains("// @sidechain proto")).toEqual([{label: "proto"}])
        })
    })
})
