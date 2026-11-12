import {describe, expect, it} from "vitest"
import {Harmony} from "@opendaw/lib-dsp"
import {ChordKeysDeviceBoxAdapter} from "./ChordKeysDeviceBoxAdapter"

const C_MAJOR: Harmony.Key = {root: 0, bits: Harmony.MajorBits}
const SEVENTH = 1, NINTH = 2, SUS2 = 4, INVERSION = 16

describe("ChordKeysDeviceBoxAdapter.nameOf", () => {
    it("names the chord the engine plays for every helper", () => {
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, 0, 60)).toBe("C")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, SEVENTH, 60)).toBe("Cmaj7")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, NINTH, 60)).toBe("Cadd9")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, SEVENTH | NINTH, 60)).toBe("Cmaj9")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, SUS2, 60)).toBe("Csus2")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, INVERSION, 64)).toBe("C/E")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, NINTH | INVERSION, 64)).toBe("Cadd9/E")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 3, NINTH, 64)).toBe("Emadd9")
        expect(ChordKeysDeviceBoxAdapter.nameOf(C_MAJOR, 1, NINTH, 62)).toBe("Cadd9/D")
    })
})

describe("ChordKeysDeviceBoxAdapter.voicing", () => {
    // the same pitches device-chord-keys plays (crates/stock-devices/device-chord-keys/src/tests.rs)
    it("plays the pitches of the engine", () => {
        const voicing = (pressed: number, helpers: number, inversion: number = 0) =>
            ChordKeysDeviceBoxAdapter.voicing(C_MAJOR, pressed, helpers, inversion, 0)
        expect(voicing(60, 0)).toEqual([60, 64, 67])
        expect(voicing(60, SEVENTH)).toEqual([60, 64, 67, 71])
        expect(voicing(60, NINTH)).toEqual([60, 64, 67, 74])
        expect(voicing(64, NINTH)).toEqual([64, 67, 71, 77])
        expect(voicing(60, SEVENTH | NINTH)).toEqual([60, 64, 67, 71, 74])
        expect(voicing(60, SUS2)).toEqual([60, 62, 67])
        expect(voicing(60, 0, 1)).toEqual([64, 67, 72])
        expect(ChordKeysDeviceBoxAdapter.voicing({root: 9, bits: Harmony.MajorBits}, 64, 0, 0, 0)).toEqual([73, 76, 80])
    })
})
