import {describe, expect, it} from "vitest"
import {MidiKeys} from "@opendaw/lib-dsp"
import {tunerNoteName} from "./TunerNoteName"

describe("tuner note labels", () => {
    it("matches the piano roll across the MIDI range", () => {
        for (let midi = 0; midi < 128; midi++) {
            expect(tunerNoteName(midi).replace("♯", "#")).toBe(MidiKeys.toFullString(midi))
        }
        expect(tunerNoteName(60)).toBe("C3")
        expect(tunerNoteName(69)).toBe("A3")
    })
    it("keeps octave labels consistent for rounded pitches and sharps", () => {
        expect(tunerNoteName(59.8)).toBe("C3")
        expect(tunerNoteName(61)).toBe("C♯3")
    })
})
