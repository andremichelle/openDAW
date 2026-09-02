// The processor announces `recordingStarted` once per recording from the flag the engine state carries
// after each render (see src/recording-start-edge.ts). The flag itself only changes in `render`, so a
// recording ended by command must reset the edge, or the next recording started before the following
// quantum reads as a continuation.
import {describe, expect, it} from "vitest"
import {RecordingStartEdge} from "../src/recording-start-edge"

describe("RecordingStartEdge", () => {
    it("announces once on the rising edge and again after a falling edge", () => {
        const edge = new RecordingStartEdge()
        expect(edge.observe(false)).toBe(false)
        expect(edge.observe(true), "the rising edge").toBe(true)
        expect(edge.observe(true), "still recording").toBe(false)
        expect(edge.observe(false)).toBe(false)
        expect(edge.observe(true), "the next recording").toBe(true)
    })

    it("announces after a reset although the flag never read false in between", () => {
        const edge = new RecordingStartEdge()
        expect(edge.observe(true)).toBe(true)
        edge.reset()
        expect(edge.observe(true), "a start following a stop command counts as new").toBe(true)
        expect(edge.observe(true)).toBe(false)
    })

    it("a reset while not recording changes nothing", () => {
        const edge = new RecordingStartEdge()
        edge.reset()
        expect(edge.observe(false)).toBe(false)
        expect(edge.observe(true)).toBe(true)
    })
})
