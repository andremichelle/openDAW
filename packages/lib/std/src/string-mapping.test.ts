import {describe, expect, it} from "vitest"
import {StringMapping} from "./string-mapping"

describe("Extract Prefix", () => {
    it("should extract prefix from string", () => {
        expect(StringMapping.numeric().y("1m")).toEqual({type: "explicit", value: 0.001})
        expect(StringMapping.numeric().y("1")).toEqual({type: "explicit", value: 1})
        expect(StringMapping.numeric().y("1k")).toEqual({type: "explicit", value: 1_000})
        expect(StringMapping.numeric({unit: "Hz"}).y("4kHz")).toEqual({type: "explicit", value: 4_000})
        expect(StringMapping.numeric({unit: "Hz"}).y("4mHz")).toEqual({type: "explicit", value: 0.004})
        expect(StringMapping.numeric({unit: "Hz"}).y("4MHz")).toEqual({type: "explicit", value: 4_000_000})
        // decimals must not eat the metric prefix ("10.0ms" once parsed as 10 seconds)
        expect(StringMapping.numeric({unit: "s"}).y("10ms")).toEqual({type: "explicit", value: 0.01})
        expect(StringMapping.numeric({unit: "s"}).y("10.0ms")).toEqual({type: "explicit", value: 0.01})
        expect(StringMapping.numeric({unit: "s"}).y("10.ms")).toEqual({type: "explicit", value: 0.01})
        expect(StringMapping.numeric({unit: "s"}).y("0.5s")).toEqual({type: "explicit", value: 0.5})
        expect(StringMapping.numeric({unit: "Hz"}).y("1.5kHz")).toEqual({type: "explicit", value: 1_500})
        expect(StringMapping.numeric().y("10.0")).toEqual({type: "explicit", value: 10})
        expect(StringMapping.numeric({unit: "Hz", unitPrefix: true}).x(1)).toEqual({value: "1", unit: "Hz"})
        expect(StringMapping.numeric({unit: "Hz", unitPrefix: true}).x(1000)).toEqual({value: "1", unit: "kHz"})
        expect(StringMapping.numeric({unit: "Hz", unitPrefix: true, fractionDigits: 1}).x(1500)).toEqual({
            value: "1.5",
            unit: "kHz"
        })
        expect(StringMapping.numeric().y("50%")).toEqual({type: "unitValue", value: 0.5})
        expect(StringMapping.numeric({bipolar: true}).y("-100%")).toEqual({type: "unitValue", value: 0.0})
        expect(StringMapping.numeric({bipolar: true}).y("0%")).toEqual({type: "unitValue", value: 0.5})
        expect(StringMapping.numeric({bipolar: true}).y("100%")).toEqual({type: "unitValue", value: 1.0})
        expect(StringMapping.numeric({bipolar: false, unit: "%"}).x(0.5)).toEqual({value: "50", unit: "%"})
        expect(StringMapping.numeric({bipolar: true, unit: "%"}).x(0.5)).toEqual({value: "0", unit: "%"})
    })
})

describe("Unit starting with a digit (#264)", () => {
    it("strips the unit before parsing so its leading digit is not merged into the value", () => {
        const mapping = StringMapping.numeric({unit: "1/32th"})
        expect(mapping.y("31/32th")).toEqual({type: "explicit", value: 3})
        expect(mapping.y("3")).toEqual({type: "explicit", value: 3})
    })
})
// The unit-entry pipeline: bare input adorned with the DISPLAYED unit, then parsed. This is what
// AutomatableParameterFieldAdapter.setPrintValue runs, so every case here is a typing scenario.
describe("withDisplayUnit", () => {
    it("adorns bare numbers, trailing dot included", () => {
        expect(StringMapping.withDisplayUnit("10", "ms")).toBe("10ms")
        expect(StringMapping.withDisplayUnit("10.", "ms")).toBe("10ms")
        expect(StringMapping.withDisplayUnit("10.0", "ms")).toBe("10.0ms")
        expect(StringMapping.withDisplayUnit(" 10 ", "ms")).toBe("10ms")
        expect(StringMapping.withDisplayUnit("-6", "dB")).toBe("-6dB")
        expect(StringMapping.withDisplayUnit("-6.", "dB")).toBe("-6dB")
        expect(StringMapping.withDisplayUnit("50", "%")).toBe("50%")
        expect(StringMapping.withDisplayUnit("10", "")).toBe("10")
    })
    it("leaves input with its own unit or non-numbers untouched", () => {
        expect(StringMapping.withDisplayUnit("10ms", "ms")).toBe("10ms")
        expect(StringMapping.withDisplayUnit("0.5s", "ms")).toBe("0.5s")
        expect(StringMapping.withDisplayUnit("50%", "%")).toBe("50%")
        expect(StringMapping.withDisplayUnit("abc", "ms")).toBe("abc")
        expect(StringMapping.withDisplayUnit("", "ms")).toBe("")
        expect(StringMapping.withDisplayUnit("∞", "s")).toBe("∞")
    })
    it("parses typed seconds values against an ms display (the pre-delay bug)", () => {
        const seconds = StringMapping.numeric({unit: "s", fractionDigits: 1, unitPrefix: true})
        const type = (text: string, displayUnit: string) => seconds.y(StringMapping.withDisplayUnit(text, displayUnit))
        expect(type("10", "ms")).toEqual({type: "explicit", value: 0.01})
        expect(type("10.", "ms")).toEqual({type: "explicit", value: 0.01})
        expect(type("10.0", "ms")).toEqual({type: "explicit", value: 0.01})
        expect(type("500", "ms")).toEqual({type: "explicit", value: 0.5})
        expect(type("0", "ms")).toEqual({type: "explicit", value: 0})
        expect(type("0.5s", "ms")).toEqual({type: "explicit", value: 0.5})
        expect(type("50%", "ms")).toEqual({type: "unitValue", value: 0.5})
        expect(type("1.5", "s")).toEqual({type: "explicit", value: 1.5})
    })
    it("round-trips the displayed value through typing for every prefix magnitude", () => {
        const seconds = StringMapping.numeric({unit: "s", fractionDigits: 1, unitPrefix: true})
        for (const value of [0.000002, 0.005, 0.01, 0.128, 0.5, 1.0, 2.5, 16.0]) {
            const printed = seconds.x(value)
            const parsed = seconds.y(StringMapping.withDisplayUnit(printed.value, printed.unit))
            expect(parsed.type, `value ${value}`).toBe("explicit")
            if (parsed.type === "explicit") {
                expect(Math.abs(parsed.value - value) / value, `value ${value}`).toBeLessThan(0.06)
            }
        }
    })
    it("keeps percent semantics", () => {
        const percent = StringMapping.percent({fractionDigits: 0})
        expect(percent.y(StringMapping.withDisplayUnit("50", "%"))).toEqual({type: "explicit", value: 0.5})
        expect(percent.y(StringMapping.withDisplayUnit("50.", "%"))).toEqual({type: "explicit", value: 0.5})
        expect(percent.y(StringMapping.withDisplayUnit("100", "%"))).toEqual({type: "explicit", value: 1.0})
        const bipolar = StringMapping.percent({bipolar: true, fractionDigits: 0})
        expect(bipolar.y(StringMapping.withDisplayUnit("-100", "%"))).toEqual({type: "explicit", value: -1.0})
        expect(bipolar.y(StringMapping.withDisplayUnit("0", "%"))).toEqual({type: "explicit", value: 0})
    })
    it("keeps decibel entry working", () => {
        const decibel = StringMapping.numeric({unit: "dB", fractionDigits: 1})
        const type = (text: string) => decibel.y(StringMapping.withDisplayUnit(text, "dB"))
        expect(type("-6")).toEqual({type: "explicit", value: -6})
        expect(type("-6.")).toEqual({type: "explicit", value: -6})
        expect(type("-6.5")).toEqual({type: "explicit", value: -6.5})
        expect(type("0")).toEqual({type: "explicit", value: 0})
    })
    it("keeps frequency entry with prefixes working", () => {
        const hertz = StringMapping.numeric({unit: "Hz", fractionDigits: 1, unitPrefix: true})
        const type = (text: string, displayUnit: string) => hertz.y(StringMapping.withDisplayUnit(text, displayUnit))
        expect(type("2", "kHz")).toEqual({type: "explicit", value: 2_000})
        expect(type("2.", "kHz")).toEqual({type: "explicit", value: 2_000})
        expect(type("1.5", "kHz")).toEqual({type: "explicit", value: 1_500})
        expect(type("440", "Hz")).toEqual({type: "explicit", value: 440})
        expect(type("440Hz", "kHz")).toEqual({type: "explicit", value: 440})
    })
})
