import {describe, expect, it} from "vitest"
import {CubedPatternData} from "./CubedPatternData"
import {CubedPatternNotes} from "./CubedPatternNotes"
import {CubedPatternTransform} from "./CubedPatternTransform"
import {CubedStep} from "./CubedStep"

const step = (note: number, active: boolean, slide = false, accent = false): CubedStep => ({note, active, slide, accent})

// C3 accented, D3 sliding into E3, a rest, G3 sliding over the loop end into C3
const pattern: CubedPatternData = {
    length: 5,
    steps: [step(60, true, false, true), step(62, true, true), step(64, true), step(40, false, true), step(67, true, true)]
}

describe("CubedPatternTransform", () => {
    it("transposes by octaves and refuses the whole shift when a playing step leaves the MIDI range", () => {
        expect(CubedPatternTransform.transpose(pattern, 12).unwrap().steps.map(({note}) => note)).toEqual([72, 74, 76, 52, 79])
        expect(CubedPatternTransform.transpose({length: 2, steps: [step(120, true), step(60, true)]}, 12).isEmpty()).toBe(true)
        expect(CubedPatternTransform.transpose({length: 2, steps: [step(120, false), step(60, true)]}, 12).unwrap()
            .steps.map(({note}) => note)).toEqual([127, 72])
    })

    it("inverts around a pivot and refuses notes that leave the MIDI range", () => {
        expect(CubedPatternTransform.invert(pattern, 60).unwrap().steps.map(({note}) => note)).toEqual([60, 58, 56, 80, 53])
        expect(CubedPatternTransform.invert({length: 1, steps: [step(10, true)]}, 100).isEmpty()).toBe(true)
        const inverted = CubedPatternTransform.invert(pattern, 60).unwrap()
        expect(CubedPatternTransform.invert(inverted, 60).unwrap()).toEqual(pattern)
    })

    it("doubles up to 64 steps", () => {
        const doubled = CubedPatternTransform.double(pattern)
        expect(doubled.length).toBe(10)
        expect(doubled.steps).toEqual([...pattern.steps, ...pattern.steps])
        const full = {length: 40, steps: Array.from({length: 40}, (_, index) => step(index, true))}
        const capped = CubedPatternTransform.double(full)
        expect(capped.length).toBe(64)
        expect(capped.steps[63].note).toBe(23)
    })

    it("reverses so every slide still joins the same two notes", () => {
        const reversed = CubedPatternTransform.reverse(pattern)
        expect(reversed.steps.map(({note}) => note)).toEqual([67, 40, 64, 62, 60])
        expect(reversed.steps.map(({accent}) => accent)).toEqual([false, false, false, false, true])
        // D3 slid into E3, so E3 now slides into D3; G3 slid over the loop end into C3 and still does
        expect(reversed.steps.map(({slide}) => slide)).toEqual([true, false, true, false, true])
        expect(CubedPatternTransform.reverse(reversed)).toEqual(pattern)
    })
})

describe("CubedPatternNotes", () => {
    it("exports the way the engine plays: sixteenths, gate length, slide overlap and accent velocity", () => {
        const notes = CubedPatternNotes.toNotes(pattern)
        expect(notes.map(({position}) => position)).toEqual([0, 240, 480, 960])
        expect(notes.map(({duration}) => duration)).toEqual([132, 252, 132, 252])
        expect(notes.map(({velocity}) => velocity >= CubedPatternNotes.AccentThreshold)).toEqual([true, false, false, false])
        expect(CubedPatternNotes.durationOf(pattern)).toBe(1200)
    })

    it("imports an exported pattern back into the same pattern unchanged", () => {
        const notes = CubedPatternNotes.toNotes(pattern)
        expect(CubedPatternNotes.fromNotes(notes, CubedPatternNotes.durationOf(pattern), pattern)).toEqual(pattern)
        const full = {length: 64, steps: Array.from({length: 64}, (_, index) =>
                step(24 + index, index % 3 !== 0, index % 5 === 0, index % 7 === 0))}
        expect(CubedPatternNotes.fromNotes(CubedPatternNotes.toNotes(full), CubedPatternNotes.durationOf(full), full)).toEqual(full)
    })

    it("imports foreign notes: snaps to sixteenths, length from the duration, overlaps slide, loud notes accent", () => {
        const empty: CubedPatternData = {length: 0, steps: []}
        const imported = CubedPatternNotes.fromNotes([
            {position: 10, duration: 100, pitch: 48, velocity: 0.9},
            {position: 470, duration: 300, pitch: 50, velocity: 0.3},
            {position: 3840, duration: 100, pitch: 52, velocity: 0.3}
        ], 3840, empty)
        expect(imported.length).toBe(16)
        expect(imported.steps[0]).toEqual(step(48, true, false, true))
        expect(imported.steps[2]).toEqual(step(50, true, true, false))
        expect(imported.steps.filter(({active}) => active)).toHaveLength(2)
    })
})
