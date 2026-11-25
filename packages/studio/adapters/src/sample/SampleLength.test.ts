import {describe, expect, it} from "vitest"
import {PPQN} from "@opendaw/lib-dsp"
import {SampleLength} from "./SampleLength"

describe("SampleLength", () => {
    const fourBars = 4 * 4 * 60 / 128
    it("snaps an import that sits on the sixteenth grid", () => {
        expect(SampleLength.musicalPulses(fourBars + 4 / 48000, 128, "import")).toBe(PPQN.Bar * 4)
    })
    it("keeps an import that is off the grid", () => {
        // 4.06 s at 120 bpm are 32.48 sixteenths
        expect(SampleLength.musicalPulses(4.06, 120, "import")).toBe(7795)
    })
    it("never snaps a recording", () => {
        expect(SampleLength.musicalPulses(fourBars + 35 / 48000, 128, "recording")).toBe(PPQN.Bar * 4 + 1)
    })
    it("snaps right up to 1% of a sixteenth and not beyond", () => {
        const sixteenth = 60 / 120 / 4
        const at = (fraction: number) => SampleLength.musicalPulses(8 * sixteenth + fraction * sixteenth, 120, "openDAW")
        expect(at(0.0099)).toBe(PPQN.SemiQuaver * 8)
        expect(at(-0.0099)).toBe(PPQN.SemiQuaver * 8)
        expect(at(0.011)).toBeGreaterThan(PPQN.SemiQuaver * 8)
    })
    it("keeps anything shorter than a sixteenth", () => {
        expect(SampleLength.musicalPulses(0.05, 120, "import")).toBe(96)
    })
    it("returns whole pulses, the warp markers store integers", () => {
        for (const duration of [0.001, 1.23456, 4.06, 7.777]) {
            expect(Number.isInteger(SampleLength.musicalPulses(duration, 97.3, "recording"))).toBe(true)
            expect(Number.isInteger(SampleLength.musicalPulses(duration, 97.3, "import"))).toBe(true)
        }
    })
})
