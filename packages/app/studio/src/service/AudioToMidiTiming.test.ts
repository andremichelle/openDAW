import {describe, expect, it} from "vitest"
import {ConstantTempoMap, PPQN} from "@opendaw/lib-dsp"
import {DefaultObservableValue} from "@opendaw/lib-std"
import {AudioToMidiTiming} from "./AudioToMidiTiming"

describe("audio-to-MIDI clip timing", () => {
    const tempo = new ConstantTempoMap(new DefaultObservableValue(120))
    it("offsets file seconds and preserves musical time for an unwarped clip", () => {
        const timing = new AudioToMidiTiming(tempo, PPQN.Bar, 1.25, [])
        expect(timing.toPulses(1.75)).toBe(PPQN.Quarter)
        expect(timing.toSeconds(PPQN.Quarter)).toBe(1.75)
    })
    it("uses each warp segment and round-trips cropped/looped positions", () => {
        const timing = new AudioToMidiTiming(tempo, 0, 2, [
            {position: 0, seconds: 0}, {position: 960, seconds: 0.25}, {position: 1920, seconds: 1.25}
        ])
        expect(timing.toPulses(2.125)).toBe(480)
        expect(timing.toPulses(2.75)).toBe(1440)
        for (const pulses of [-480, 0, 240, 960, 1440, 1920, 2400]) {
            expect(timing.toPulses(timing.toSeconds(pulses))).toBeCloseTo(pulses)
        }
    })
    it("rejects invalid warp markers instead of producing invalid MIDI notes", () => {
        expect(() => new AudioToMidiTiming(tempo, 0, 0, [
            {position: 0, seconds: 1}, {position: 960, seconds: 1}
        ])).toThrow("increase")
    })
})
