import {describe, expect, it} from "vitest"
import {PPQN} from "@opendaw/lib-dsp"
import {RecordMidi} from "./RecordMidi"

describe("RecordMidi.latencyInPulses (#379)", () => {
    it("converts a browser-reported output latency to pulses at the given tempo", () => {
        expect(RecordMidi.latencyInPulses(0.02, 120)).toBe(PPQN.secondsToPulses(0.02, 120))
    })

    it("compensates by nothing when outputLatency is unavailable, not by ten seconds", () => {
        // Safari and iOS before 18.4 do not implement outputLatency. The old `?? 10.0` placed every note
        // ~20 beats (five bars at 120 bpm) late; the fallback must be no compensation.
        expect(RecordMidi.latencyInPulses(undefined, 120)).toBe(0)
    })

    it("uses the current tempo, so a faster tempo yields a larger pulse offset", () => {
        expect(RecordMidi.latencyInPulses(0.02, 60)).toBe(PPQN.secondsToPulses(0.02, 60))
        expect(RecordMidi.latencyInPulses(0.02, 140)).toBeGreaterThan(RecordMidi.latencyInPulses(0.02, 60))
    })

    it("treats an explicit zero as zero (output not yet running)", () => {
        expect(RecordMidi.latencyInPulses(0, 120)).toBe(0)
    })
})
