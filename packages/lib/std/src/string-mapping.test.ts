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