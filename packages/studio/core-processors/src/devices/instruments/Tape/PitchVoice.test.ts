// Issue #312: PitchVoice must NOT stack its internal anti-click fade with the region clip-fade.
// A voice that starts mid-file (offset != 0) runs a 20 ms internal fade-in as a declick. When the region ALSO
// authors a fade (passed in via `fadingGainBuffer`), the buggy `finalAmplitude = amplitude * fadingGainBuffer[i]`
// multiplies two 0->1 ramps -> a quadratic entry that dips ~-1.2 dB below the intended linear crossfade.
// Correct (mirrors the Rust engine's `fade_gain` which returns `fade_in.min(fade_out)`): combine by MIN, so the
// authored fade replaces the declick where it is the smaller, and the declick still protects an un-faded entry.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {PitchVoice} from "./PitchVoice"

;(globalThis as Record<string, unknown>).sampleRate = 44_100

const constantData = (value: number): AudioData => {
    const data = AudioData.create(44_100, 1000, 2)
    for (let channel = 0; channel < 2; channel++) { data.frames[channel].fill(value) }
    return data
}

describe("PitchVoice #312 — internal fade must not stack with the region clip-fade", () => {
    it("a region clip-fade-in is not squared by the internal declick", () => {
        const data = constantData(1.0) // constant so output == the applied gain envelope
        const output = new AudioBuffer(2)
        const internalFade = 20 // internal declick length (samples)
        const authoredFade = 40 // region clip-fade length (samples)
        // authored linear fade-in ramp 0..1 over `authoredFade`, then unity
        const fadingGainBuffer = new Float32Array(128)
        for (let i = 0; i < 128; i++) { fadingGainBuffer[i] = Math.min(1.0, i / authoredFade) }
        // offset != 0 -> the voice enters its internal fade-in (the declick that the bug squares)
        const voice = new PitchVoice(UUID.generate(), output, data, internalFade, 1.0, 100, 0)
        voice.process(0, 128, fadingGainBuffer)
        const outL = output.channels()[0]
        // The intended envelope is the AUTHORED fade alone (constant source * region fade). The internal declick
        // must not pull it below that. Measure the worst downward deviation across the authored fade window.
        let worstDip = 0
        for (let i = 1; i < authoredFade; i++) { worstDip = Math.max(worstDip, fadingGainBuffer[i] - outL[i]) }
        // headline sample: at i=10 intended=0.25; the bug squares to 0.5*0.25=0.125
        expect(outL[10]).toBeCloseTo(0.25, 2)
        expect(worstDip).toBeLessThan(0.02)
    })

    it("an un-faded mid-file entry still gets the internal declick (unity clip-fade)", () => {
        const data = constantData(1.0)
        const output = new AudioBuffer(2)
        const internalFade = 20
        const fadingGainBuffer = new Float32Array(128).fill(1.0) // no authored fade
        const voice = new PitchVoice(UUID.generate(), output, data, internalFade, 1.0, 100, 0)
        voice.process(0, 128, fadingGainBuffer)
        const outL = output.channels()[0]
        // declick preserved: ramps 0 -> 1 over the internal fade, unity after
        expect(outL[0]).toBeCloseTo(0.0, 3)
        expect(outL[10]).toBeCloseTo(0.5, 2)
        expect(outL[25]).toBeCloseTo(1.0, 3)
    })
})
