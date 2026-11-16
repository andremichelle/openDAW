import {describe, expect, it} from "vitest"
import {GuitarPatterns} from "./GuitarPatterns"

// projects store the pattern index, so the original patterns must keep their positions
const OriginalNames = [
    "Down Quarters", "Down Eighths", "Down Up Eighths", "Pop", "Folk", "Island", "Sixteenths", "Ballad Strum",
    "Strum and Ring", "Two Bar Pop", "Rock Eighths", "Power Drive", "Gallop", "Punk", "Anthem", "Funk Sixteenths",
    "Funk Chops", "Motown", "Disco", "Soul Ballad", "Reggae", "One Drop", "Ska", "Rocksteady", "Bossa Nova", "Rumba",
    "Samba", "Son Montuno", "Tango", "Boom Chick", "Train Beat", "Waltz", "Two Step", "Travis", "Arpeggio Up",
    "Arpeggio Up Down", "Ballad Picking", "Pinch", "Six Eight", "Classical"
]

describe("GuitarPatterns", () => {
    it("keeps the original patterns at their indices", () => {
        expect(GuitarPatterns.Library.slice(0, OriginalNames.length).map(({name}) => name)).toEqual(OriginalNames)
        expect(GuitarPatterns.nameOf(GuitarPatterns.DefaultPattern)).toBe("Folk")
    })
    it("has unique names", () => {
        const names = GuitarPatterns.Library.map(({name}) => name)
        expect(new Set(names).size).toBe(names.length)
    })
    it("uses only known letters and fits the step count", () => {
        GuitarPatterns.Library.forEach(({name, text}) => {
            expect(GuitarPatterns.tokens(text).join(""), name).toBe(text)
            GuitarPatterns.tokens(text).forEach(token => expect(token, name).toMatch(/^([DUduMmpXcBAS1-6.\-]|\([1-6]{2,6}\))$/))
            expect(GuitarPatterns.parse(text).length, name).toBeLessThanOrEqual(GuitarPatterns.StepCount)
        })
    })
    it("picks grouped strings together in one step", () => {
        const steps = GuitarPatterns.parse("(61).3")
        expect(steps.length).toBe(3)
        expect(steps[0]).toMatchObject({kind: GuitarPatterns.Pick, strings: 0b100001})
        expect(steps[2]).toMatchObject({kind: GuitarPatterns.Pick, strings: 0b001000})
    })
    it("plays the low strings for m and p", () => {
        const [chug, power] = GuitarPatterns.parse("mp")
        expect(chug).toMatchObject({kind: GuitarPatterns.Mute, strings: 0b000111})
        expect(power).toMatchObject({kind: GuitarPatterns.Down, strings: 0b000111})
    })
})
