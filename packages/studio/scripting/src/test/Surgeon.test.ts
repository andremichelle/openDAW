import {describe, expect, it} from "vitest"
import {createFixture} from "./Fixture"

describe("Surgeon", () => {
    it("exposes its globals, the live controls and eight patterns", () => {
        const {project} = createFixture()
        const {instrument} = project.addInstrumentUnit("Surgeon")
        expect(instrument.key).toBe("Surgeon")
        expect(instrument.volume).toBe(-3)
        expect(instrument.slot).toBe(0)
        expect(instrument.pattern).toBe(0)
        expect(instrument.patterns.length).toBe(8)
        expect(instrument.live.steps).toBe(7)
        expect(instrument.patterns[0].steps).toBe(7)
        expect(instrument.patterns[0].mutate).toBe(0)
    })
    it("writes a stored pattern, the slot and the tune", () => {
        const {project} = createFixture()
        const {instrument} = project.addInstrumentUnit("Surgeon")
        instrument.patterns[3].seed = 4711
        instrument.patterns[3].feedbackA = -0.5
        instrument.patterns[3].wave = 3
        instrument.slot = 3
        instrument.tune = 220
        expect(instrument.patterns[3].seed).toBe(4711)
        expect(instrument.patterns[3].feedbackA).toBe(-0.5)
        expect(instrument.patterns[3].wave).toBe(3)
        expect(instrument.patterns[2].seed).not.toBe(4711)
        expect(instrument.slot).toBe(3)
        expect(instrument.tune).toBe(220)
    })
    it("selects a pattern: the live values become it and the pattern left keeps its edits", () => {
        const {project} = createFixture()
        const {instrument} = project.addInstrumentUnit("Surgeon")
        const second = instrument.patterns[1].seed
        instrument.live.seed = 4711
        expect(instrument.patterns[0].seed).toBe(4711)
        instrument.select(1)
        expect(instrument.slot).toBe(1)
        expect(instrument.pattern).toBe(1)
        expect(instrument.live.seed).toBe(second)
        expect(instrument.patterns[0].seed).toBe(4711)
        instrument.patterns[1].seed = 815
        expect(instrument.live.seed).toBe(815)
        instrument.select(0)
        expect(instrument.live.seed).toBe(4711)
        expect(instrument.patterns[1].seed).toBe(815)
        expect(() => instrument.select(8)).toThrow()
    })
    it("starts the other patterns as rolled patterns with Mutate at zero", () => {
        const {project} = createFixture()
        const {instrument: {patterns}} = project.addInstrumentUnit("Surgeon")
        const seeds = patterns.map(pattern => pattern.seed)
        expect(new Set(seeds).size).toBe(8)
        patterns.forEach(pattern => {
            expect(pattern.mutate).toBe(0)
            expect(pattern.laneAMutate).toBe(0)
            expect(pattern.rate).toBe(1)
        })
    })
})
