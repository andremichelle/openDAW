import {describe, expect, it} from "vitest"
import {ChordDetection} from "./chord-detection"
import {Harmony} from "./harmony"

const weightsOf = (...pitches: ReadonlyArray<number>): Float64Array => {
    const weights = new Float64Array(12)
    pitches.forEach(pitch => weights[pitch % 12] += 1)
    return weights
}

const name = (pitches: ReadonlyArray<number>): string => ChordDetection
    .detectChord(weightsOf(...pitches), Math.min(...pitches))
    .mapOr(({root, bits, bass}) => {
        const stack: Array<number> = []
        for (let interval = 0; interval < 12; interval++) {if ((bits & (1 << interval)) !== 0) {stack.push(interval)}}
        const bassIndex = stack.findIndex(interval => (root + interval) % 12 === bass)
        const voicing = [...stack.slice(bassIndex), ...stack.slice(0, bassIndex).map(interval => interval + 12)]
        return Harmony.chordName({root, stack, voicing, bits, shaped: true})
    }, "none")

const MinorBits = 0b010110101101

describe("ChordDetection", () => {
    it("names triads, sevenths and inversions", () => {
        expect(name([60, 64, 67])).toBe("C")
        expect(name([57, 60, 64])).toBe("Am")
        expect(name([59, 62, 65])).toBe("Bdim")
        expect(name([55, 59, 62, 65])).toBe("G7")
        expect(name([60, 64, 67, 71])).toBe("Cmaj7")
        expect(name([57, 60, 64, 67])).toBe("Am7")
        expect(name([64, 67, 72])).toBe("C/E")
        expect(name([60, 62, 67])).toBe("Csus2")
    })
    it("tolerates a missing fifth in sevenths and needs three pitch classes", () => {
        expect(name([55, 59, 65])).toBe("G7")
        expect(name([60, 64])).toBe("none")
        expect(name([60, 72, 84])).toBe("none")
    })
    it("ignores quiet passing notes", () => {
        const weights = weightsOf(60, 64, 67)
        weights[2] = 0.1
        expect(ChordDetection.detectChord(weights, 60).unwrap()).toEqual({root: 0, bits: 0b10010001, bass: 0})
    })
    it("detects major and minor keys", () => {
        const cMajor = weightsOf(60, 62, 64, 65, 67, 69, 71, 60, 64, 67)
        expect(ChordDetection.detectKey(cMajor).unwrap()).toEqual({root: 0, bits: Harmony.MajorBits})
        const aMinor = weightsOf(57, 59, 60, 62, 64, 65, 67, 57, 60, 64, 57)
        expect(ChordDetection.detectKey(aMinor).unwrap()).toEqual({root: 9, bits: MinorBits})
        expect(ChordDetection.detectKey(new Float64Array(12)).isEmpty()).toBe(true)
    })
    it("maps chords onto steps of the key", () => {
        const cMajor = Harmony.DefaultKey
        const step = (pitches: ReadonlyArray<number>, key: Harmony.Key = cMajor) => ChordDetection
            .toStep(key, ChordDetection.detectChord(weightsOf(...pitches), Math.min(...pitches)).unwrap()).unwrap()
        expect(step([55, 59, 62])).toEqual({degree: 5, shift: 0, shape: 0, notes: 3, inversion: 0})
        expect(step([55, 59, 62, 65])).toEqual({degree: 5, shift: 0, shape: 0, notes: 4, inversion: 0})
        expect(step([64, 67, 72])).toEqual({degree: 1, shift: 0, shape: 0, notes: 3, inversion: 1})
        expect(step([58, 62, 65])).toEqual({degree: 7, shift: -1, shape: 0b10010001, notes: 3, inversion: 0})
        expect(step([62, 66, 69])).toEqual({degree: 2, shift: 0, shape: 0b10010001, notes: 3, inversion: 0})
        expect(step([57, 61, 64, 67], {root: 9, bits: 0b010011101001}))
            .toEqual({degree: 1, shift: 0, shape: 0, notes: 3, inversion: 0}, "a blues step 1 is a dominant 7th already")
    })
    const bar = 3840
    const chord = (position: number, duration: number, ...pitches: ReadonlyArray<number>) =>
        pitches.map(pitch => ({position, duration, pitch}))
    const summary = (segments: ReadonlyArray<ChordDetection.Segment>) =>
        segments.map(({position, duration, chord: {root}}) => [position, duration, root])
    it("starts a chord where its notes start and holds it until the next chord", () => {
        const notes = [...chord(0, bar, 60, 64, 67), ...chord(bar, bar / 2, 57, 60, 64), ...chord(bar * 2, bar, 55, 59, 62, 65)]
        expect(summary(ChordDetection.segment(notes, 0, bar * 3))).toEqual([[0, bar, 0], [bar, bar, 9], [bar * 2, bar, 7]])
    })
    it("places short chords off the beat at their notes", () => {
        const notes = [...chord(0, 240, 62, 65, 69), ...chord(1440, 240, 64, 67, 71)]
        expect(summary(ChordDetection.segment(notes, 0, bar))).toEqual([[0, 1440, 2], [1440, bar - 1440, 4]])
    })
    it("takes a strummed chord as one onset", () => {
        const notes = [...chord(0, bar, 60), ...chord(40, bar, 64), ...chord(90, bar, 67)]
        expect(summary(ChordDetection.segment(notes, 0, bar))).toEqual([[0, bar, 0]])
    })
    it("collects arpeggiated notes into their chord", () => {
        const notes = [...chord(0, 240, 60), ...chord(240, 240, 64), ...chord(480, 240, 67), ...chord(720, 240, 72),
            ...chord(bar, 240, 65), ...chord(bar + 240, 240, 69), ...chord(bar + 480, 240, 72)]
        expect(summary(ChordDetection.segment(notes, 0, bar * 2))).toEqual([[0, bar, 0], [bar, bar, 5]])
    })
})
