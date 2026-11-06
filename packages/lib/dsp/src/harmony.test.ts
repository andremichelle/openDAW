import {describe, expect, it} from "vitest"
import {Harmony} from "./harmony"
import {MidiKeys} from "./midi-keys"

const scaleBits = (name: string) => MidiKeys.StockScales.find(scale => scale.name === name)!.bits
const CMajor: Harmony.Key = {root: 0, bits: Harmony.MajorBits}

// reference: brute force nearest member, ties resolve downwards
const reference = (pitch: number, key: Harmony.Key): number => {
    let best = pitch
    let bestDistance = Infinity
    for (let candidate = 0; candidate <= 127; candidate++) {
        if (!Harmony.has(candidate, key)) {continue}
        const distance = Math.abs(candidate - pitch)
        if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
            best = candidate
            bestDistance = distance
        }
    }
    return best
}

describe("Harmony.quantise", () => {
    it("keeps notes of the key", () => {
        for (const pitch of [60, 62, 64, 65, 67, 69, 71, 72]) {
            expect(Harmony.quantise(pitch, CMajor)).toBe(pitch)
        }
    })
    it("moves black keys in C major down on ties", () => {
        expect(Harmony.quantise(61, CMajor)).toBe(60)
        expect(Harmony.quantise(63, CMajor)).toBe(62)
        expect(Harmony.quantise(66, CMajor)).toBe(65)
        expect(Harmony.quantise(68, CMajor)).toBe(67)
        expect(Harmony.quantise(70, CMajor)).toBe(69)
    })
    it("crosses the octave", () => {
        const key: Harmony.Key = {root: 0, bits: scaleBits("Pentatonic Major")}
        expect(Harmony.quantise(71, key)).toBe(72)
        expect(Harmony.quantise(61, key)).toBe(60)
    })
    it("never leaves 0..127", () => {
        const key: Harmony.Key = {root: 1, bits: 1}
        expect(Harmony.quantise(0, key)).toBe(1)
        expect(Harmony.quantise(127, key)).toBe(121)
    })
    it("matches the reference for every stock scale, root and pitch", () => {
        for (const scale of MidiKeys.StockScales) {
            for (let root = 0; root < 12; root++) {
                const key: Harmony.Key = {root, bits: scale.bits}
                for (let pitch = 0; pitch <= 127; pitch++) {
                    expect(Harmony.quantise(pitch, key)).toBe(reference(pitch, key))
                }
            }
        }
    })
    it("passes notes through without a scale", () => {
        expect(Harmony.quantise(61, {root: 0, bits: 0})).toBe(61)
    })
})

describe("Harmony.chord", () => {
    const names = (key: Harmony.Key) => [1, 2, 3, 4, 5, 6, 7]
        .map(degree => Harmony.chordName(Harmony.chord(key, degree, 0, 0).unwrap()))
    it("builds the triads of C major", () => {
        expect(names(CMajor)).toEqual(["C", "Dm", "Em", "F", "G", "Am", "Bdim"])
    })
    it("follows a key change", () => {
        expect(names({root: 5, bits: Harmony.MajorBits})).toEqual(["F", "Gm", "Am", "A#", "C", "Dm", "Edim"])
    })
    it("follows the scale", () => {
        expect(names({root: 0, bits: scaleBits("Natural Minor")})).toEqual(["Cm", "Ddim", "D#", "Fm", "Gm", "G#", "A#"])
        expect(names({root: 9, bits: scaleBits("Harmonic Minor")})[4]).toBe("E")
    })
    it("applies shift and shape relative to the key", () => {
        const major = Harmony.ChordShapes[0].bits
        expect(Harmony.chordName(Harmony.chord(CMajor, 7, -1, major).unwrap())).toBe("A#")
        expect(Harmony.chordName(Harmony.chord({root: 5, bits: Harmony.MajorBits}, 7, -1, major).unwrap())).toBe("D#")
        expect(Harmony.chordName(Harmony.chord(CMajor, 5, 0, Harmony.ChordShapes[6].bits).unwrap())).toBe("G7")
    })
    it("yields no chord for scales without 7 notes", () => {
        for (const name of ["Pentatonic Major", "Pentatonic Minor", "Blues", "Whole Tone", "Diminished", "Augmented"]) {
            expect(Harmony.chord({root: 0, bits: scaleBits(name)}, 1, 0, 0).isEmpty()).toBe(true)
        }
    })
    it("rejects degrees outside 1..7", () => {
        expect(Harmony.chord(CMajor, 0, 0, 0).isEmpty()).toBe(true)
        expect(Harmony.chord(CMajor, 8, 0, 0).isEmpty()).toBe(true)
    })
    it("names keys", () => {
        expect(Harmony.keyName(CMajor)).toBe("C Major")
        expect(Harmony.keyName({root: 9, bits: scaleBits("Natural Minor")})).toBe("A Natural Minor")
        expect(Harmony.keyName({root: 0, bits: 0b1})).toBe("C Custom")
    })
})
