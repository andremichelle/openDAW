import {describe, expect, it} from "vitest"
import {isDefined} from "@opendaw/lib-std"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const {insetRadius} = await import("@/ui/analysis/AnalysisCommon")

describe("insetRadius", () => {
    it("insets half the smaller side", () => {
        expect(insetRadius(200, 100, 1.0)).toBe(49.0)
        expect(insetRadius(100, 200, 1.0)).toBe(49.0)
    })
    it("never returns a negative radius (live error 1107)", () => {
        // one CSS pixel of card body at devicePixelRatio 1.75 (Chrome at 175% scaling)
        expect(insetRadius(1000, 1.75, 1.0)).toBe(0.0)
        expect(insetRadius(1000, 1.0, 1.0)).toBe(0.0)
        expect(insetRadius(0, 0, 1.0)).toBe(0.0)
    })
    it("is exactly zero at the inset boundary", () => {
        expect(insetRadius(4, 4, 2.0)).toBe(0.0)
    })
})
