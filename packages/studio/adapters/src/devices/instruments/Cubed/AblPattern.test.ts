import {describe, expect, it} from "vitest"
import {AblPattern} from "./AblPattern"

describe("AblPattern", () => {
    // Ground truth: these 16 lines are the head of `userlab.pat`, and the expectations are the
    // pattern ABL3 itself produced after loading that file (dumped out of the plugin's state chunk).
    // The column order is the whole risk here - the file writes GATE LAST, which is NOT the order the
    // plugin's own state XML uses (pitch gate down up accent slide). Reading it in XML order parses
    // cleanly and silently yields a transposed pattern full of wrong rests, so this test exists to
    // catch exactly that.
    const USERLAB = `; ABL3 Meta tag: 16
; Triplet: 0.000000 Shuffle: 0.000000
10 0 1 0 1 1
0 0 1 1 1 1
0 0 0 0 0 1
0 0 0 0 0 0
0 0 0 0 0 1
7 0 0 0 0 1
3 0 0 0 1 1
3 0 0 0 0 1
3 1 0 0 0 1
3 0 0 0 1 1
10 0 0 0 0 1
10 0 1 0 0 1
0 0 0 1 0 0
0 0 0 1 0 1
0 0 0 1 1 1
5 0 0 1 0 1`

    it("parses the ABL3 dialect exactly as the plugin does", () => {
        const {steps, length} = AblPattern.parse(USERLAB)
        expect(length).toBe(16)
        // pitch + octave shift against the plugin base note 36; these are exactly the notes the
        // calibrated userlab pattern uses (27..58)
        expect(steps.map(step => step.note)).toEqual(
            [58, 48, 36, 36, 36, 43, 39, 39, 27, 39, 46, 58, 36, 36, 36, 41])
        expect(steps.map(step => step.active)).toEqual(
            [true, true, true, false, true, true, true, true, true, true, true, true, false, true, true, true])
        expect(steps.map(step => step.accent)).toEqual(
            [false, true, false, false, false, false, false, false, false, false, false, false, true, true, true, true])
        expect(steps.map(step => step.slide)).toEqual(
            [true, true, false, false, false, false, true, false, false, true, false, false, false, false, true, false])
    })

    // The head of Famous/Acid_Knife.pat. ABL2 puts GATE FIRST, unlike ABL3 - reading it in the ABL3
    // position loads this pattern (and 12 others in the factory library) completely silent.
    it("parses the ABL2 dialect, where gate comes first and the octave lives in the note name", () => {
        const {steps} = AblPattern.parse("; ABL2 Meta tag: 4\nf#2 1 0 0\nf#3 0 0 0\nf#3 1 0 0\na#3 1 1 1")
        expect(steps.map(step => step.note)).toEqual([30, 42, 42, 46])
        expect(steps.map(step => step.active)).toEqual([true, false, true, true])
        expect(steps.map(step => step.accent)).toEqual([false, false, false, true])
        expect(steps.map(step => step.slide)).toEqual([false, false, false, true])
    })

    it("never loads a factory pattern completely silent", () => {
        // the failure this guards: an ABL2 pattern whose gate column is misread has zero active steps
        const {steps} = AblPattern.parse("; ABL2\nf#2 1 0 0\nf#3 0 0 0\nf#3 1 0 0")
        expect(steps.some(step => step.active)).toBe(true)
    })

    it("ignores comments and blank lines rather than treating them as steps", () => {
        expect(AblPattern.parse("; header\n\n  \n0 0 0 0 0 1\n").length).toBe(1)
    })

    it("returns an empty pattern for a file that is not a pattern at all", () => {
        expect(AblPattern.parse("not a pattern\nat all").steps).toHaveLength(0)
    })
})
