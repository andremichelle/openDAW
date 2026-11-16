import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, GuitarDeviceBox} from "@opendaw/studio-boxes"
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
    it("seeds sixteen different slots from the library", () => {
        expect(GuitarPatterns.SeedNames.length).toBe(GuitarPatterns.SlotCount)
        expect(new Set(GuitarPatterns.SeedNames).size).toBe(GuitarPatterns.SlotCount)
        GuitarPatterns.SeedNames.forEach(name =>
            expect(GuitarPatterns.Library.some(pattern => pattern.name === name), name).toBe(true))
        expect(GuitarPatterns.SeedNames[0]).toBe("Folk")
    })
    it("snapshot and apply round trip and clamp foreign values", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        boxGraph.beginTransaction()
        const box = GuitarDeviceBox.create(boxGraph, UUID.generate())
        const [source, target] = [GuitarPatterns.slot(box, 0), GuitarPatterns.slot(box, 1)]
        GuitarPatterns.load(source, GuitarPatterns.DefaultPattern)
        GuitarPatterns.apply(target, GuitarPatterns.snapshot(source))
        expect(GuitarPatterns.snapshot(target)).toEqual(GuitarPatterns.snapshot(source))
        GuitarPatterns.apply(target, {kinds: [99], strings: [255], velocities: [-5], speeds: [500], length: 99, library: 9999})
        const clamped = GuitarPatterns.snapshot(target)
        expect([clamped.kinds[0], clamped.strings[0], clamped.velocities[0], clamped.speeds[0]]).toEqual([GuitarPatterns.Chop, 63, 0, 100])
        expect([clamped.kinds[1], clamped.length, clamped.library]).toEqual([GuitarPatterns.Rest, GuitarPatterns.StepCount, -1])
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
