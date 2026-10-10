import {describe, expect, it} from "vitest"
import {MidiKeys} from "@opendaw/lib-dsp"
import {tunerNoteName} from "./TunerNoteName"

describe("tuner note labels", () => {
    it("matches the piano roll across the MIDI range", () => {
        for (let midi = 0; midi < 128; midi++) {
            expect(tunerNoteName(midi, 0).replace("♯", "#")).toBe(MidiKeys.toFullString(midi))
        }
        expect(tunerNoteName(60, 0)).toBe("C3")
        expect(tunerNoteName(69, 0)).toBe("A3")
    })
    it("keeps octave labels consistent for rounded pitches and alternate spellings", () => {
        expect(tunerNoteName(59.8, 0)).toBe("C3")
        expect(tunerNoteName(61, 1)).toBe("D♭3")
        expect(tunerNoteName(61, 2)).toBe("C♯/D♭3")
    })
})
