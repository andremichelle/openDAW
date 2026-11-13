import {describe, expect, it} from "vitest"
import {ScriptFormValues} from "./ScriptFormValues"

describe("ScriptFormValues", () => {
    it("counts the fraction digits of a step", () => {
        expect(ScriptFormValues.digitsOf(1)).toBe(0)
        expect(ScriptFormValues.digitsOf(5)).toBe(0)
        expect(ScriptFormValues.digitsOf(0.5)).toBe(1)
        expect(ScriptFormValues.digitsOf(0.25)).toBe(2)
        expect(ScriptFormValues.digitsOf(0.1)).toBe(1)
        expect(ScriptFormValues.digitsOf(0.001)).toBe(3)
        expect(ScriptFormValues.digitsOf(1 / 3)).toBe(6)
    })

    describe("number", () => {
        it("snaps to the step from min and stays within the range", () => {
            const {guard, mapper, maxChars, step, decimal} = ScriptFormValues.number(
                {type: "number", label: "", value: 32, min: 1, max: 64, step: 1})
            expect(guard.guard(12.4)).toBe(12)
            expect(guard.guard(0)).toBe(1)
            expect(guard.guard(1000)).toBe(64)
            expect(guard.guard(-Infinity)).toBe(1)
            expect(mapper.x(32).value).toBe("32")
            expect([maxChars, step, decimal]).toEqual([2, 1, false])
        })
        it("counts steps from min, not from zero", () => {
            const {guard} = ScriptFormValues.number({type: "number", label: "", value: 1, min: 1, max: 10, step: 3})
            expect([1, 2, 3, 5, 6, 9, 10].map(value => guard.guard(value))).toEqual([1, 1, 4, 4, 7, 10, 10])
        })
        it("keeps fractional steps free of float noise", () => {
            const {guard, mapper, decimal} = ScriptFormValues.number({type: "number", label: "", value: 0, step: 0.1})
            expect(guard.guard(0.1 + 0.2)).toBe(0.3)
            expect(guard.guard(-0.34)).toBe(-0.3)
            expect(mapper.x(0.3).value).toBe("0.3")
            expect(decimal).toBe(true)
        })
        it("leaves a number without a step free", () => {
            const {guard, mapper, step, decimal, maxChars} = ScriptFormValues.number({type: "number", label: "", value: 440})
            expect(guard.guard(441.37)).toBe(441.37)
            expect(guard.guard(-1e9)).toBe(-1e9)
            expect(mapper.x(440).value).toBe("440")
            expect(mapper.x(0.1 + 0.2).value).toBe("0.3")
            expect([step, decimal, maxChars]).toEqual([1, true, 8])
        })
        it("only bounds the given side", () => {
            const {guard} = ScriptFormValues.number({type: "number", label: "", value: 5, min: 0})
            expect(guard.guard(-3)).toBe(0)
            expect(guard.guard(1e12)).toBe(1e12)
        })
        it("parses typed text, comma or point", () => {
            const {mapper} = ScriptFormValues.number({type: "number", label: "", value: 0})
            expect(mapper.y(" 12.5 ")).toEqual({type: "explicit", value: 12.5})
            expect(mapper.y("12,5")).toEqual({type: "explicit", value: 12.5})
            expect(mapper.y("-3")).toEqual({type: "explicit", value: -3})
            expect(mapper.y("").type).toBe("unknown")
            expect(mapper.y("abc").type).toBe("unknown")
            expect(mapper.y("Infinity").type).toBe("unknown")
        })
    })

    describe("slider", () => {
        it("travels linear and shows what it returns", () => {
            const {guard, mapper, mapping, maxChars, decimal} = ScriptFormValues.slider(
                {type: "slider", label: "", value: 0.5, min: 0, max: 1})
            expect(mapping.y(0)).toBe(0)
            expect(mapping.y(0.5)).toBe(0.5)
            expect(mapping.y(1)).toBe(1)
            expect(guard.guard(0.123456)).toBe(0.12)
            expect(mapper.x(guard.guard(0.123456)).value).toBe("0.12")
            expect([maxChars, decimal]).toEqual([4, true])
        })
        it("travels exponential between the ends", () => {
            const {guard, mapping, mapper} = ScriptFormValues.slider(
                {type: "slider", label: "", value: 45, min: 1, max: 200, mapping: "exp"})
            expect(mapping.y(0)).toBe(1)
            expect(mapping.y(1)).toBe(200)
            expect(mapping.y(0.5)).toBeCloseTo(Math.sqrt(200), 6)
            expect(mapping.x(mapping.y(0.3))).toBeCloseTo(0.3, 9)
            expect(guard.guard(mapping.y(0.5))).toBe(14.14)
            expect(mapper.x(200).value).toBe("200.00")
        })
        it("returns whole numbers for int", () => {
            const {guard, mapper, decimal, step} = ScriptFormValues.slider(
                {type: "slider", label: "", value: 3, min: 1, max: 12, mapping: "int"})
            expect(guard.guard(3.49)).toBe(3)
            expect(guard.guard(3.5)).toBe(4)
            expect(guard.guard(99)).toBe(12)
            expect(mapper.x(12).value).toBe("12")
            expect([decimal, step]).toEqual([false, 1])
        })
        it("snaps to a given step", () => {
            const {guard, mapper} = ScriptFormValues.slider(
                {type: "slider", label: "", value: 0, min: -1, max: 1, step: 0.25})
            expect(guard.guard(0.3)).toBe(0.25)
            expect(guard.guard(-0.9)).toBe(-1)
            expect(mapper.x(0.25).value).toBe("0.25")
        })
        it("uses fewer digits on wide ranges and more on narrow ones", () => {
            expect(ScriptFormValues.slider({type: "slider", label: "", value: 0, min: 0, max: 1000}).mapper.x(12.34).value).toBe("12")
            expect(ScriptFormValues.slider({type: "slider", label: "", value: 0, min: 0, max: 50}).mapper.x(12.34).value).toBe("12.3")
            expect(ScriptFormValues.slider({type: "slider", label: "", value: 0, min: 0, max: 0.01}).mapper.x(0.00123).value).toBe("0.0012")
            expect(ScriptFormValues.slider({type: "slider", label: "", value: 0.001, min: 0.001, max: 1, mapping: "exp"}).mapper.x(0.00123).value).toBe("0.00123")
        })
    })
})
