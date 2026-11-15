import {describe, expect, it} from "vitest"
import {EuclidNotes} from "./EuclidNotes"
import {EuclidRhythm} from "./EuclidRhythm"

const lane = (pulses: number, extra: Partial<EuclidNotes.Lane> = {}, accents: number = 0, bursts: number = 0): EuclidNotes.Lane => ({
    note: 60, velocity: 0.5, gate: 0, audible: true, step: 240, repeats: 3, fade: 0,
    steps: EuclidRhythm.steps({steps: 16, pulses, rotate: 0, accents, accentRotate: 0, bursts, burstRotate: 0}), ...extra
})

describe("EuclidNotes", () => {
    it("places a lane's hits for one step each, accents at full velocity", () => {
        expect(EuclidNotes.of([lane(4, {}, 2)], 3840, Infinity)).toEqual([
            {position: 0, duration: 240, pitch: 60, velocity: 1},
            {position: 960, duration: 240, pitch: 60, velocity: 0.5},
            {position: 1920, duration: 240, pitch: 60, velocity: 1},
            {position: 2880, duration: 240, pitch: 60, velocity: 0.5}
        ])
    })

    it("plays bursts as fading triggers and lasts until the next hit", () => {
        const notes = EuclidNotes.of([lane(1, {gate: 1, fade: 0.5, repeats: 2}, 0, 1)], 3840, Infinity)
        expect(notes).toEqual([
            {position: 0, duration: 120, pitch: 60, velocity: 0.5},
            {position: 120, duration: 3720, pitch: 60, velocity: 0.25}
        ])
    })

    it("restarts at the period, skips silent lanes and keeps the louder of two equal notes", () => {
        const notes = EuclidNotes.of([lane(4), lane(4, {velocity: 0.9}), lane(4, {note: 62, audible: false})], 3840, 1440)
        expect(notes.map(note => note.position)).toEqual([0, 960, 1440, 2400, 2880])
        expect(notes.every(note => note.velocity === 0.9)).toBe(true)
    })
})
