// End-to-end: sunset.od (Vaporisateur, StereoTool, Compressor, Delay, Crusher, DattorroReverb, Tape, and 5
// Revamp EQs) must render through the Rust engine without NaN, with its sample asset loaded, and produce audio.
import {describe, expect, it} from "vitest"
import {renderOd} from "./helpers/render-od"

describe("sunset.od render", () => {
    it("renders finite, audible output with all devices + assets", async () => {
        const {output, audioFiles, samplesLoaded} = await renderOd("sunset", 256)
        console.log(`sunset: audioFiles=${audioFiles} samplesLoaded=${samplesLoaded}`)
        const nan = output.some(sample => !Number.isFinite(sample))
        const peak = output.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
        console.log(`sunset: peak=${peak.toFixed(4)} nan=${nan}`)
        expect(nan).toBe(false)
        expect(peak).toBeGreaterThan(0.01)
        expect(samplesLoaded).toBeGreaterThanOrEqual(audioFiles) // every AudioFileBox asset resolved
    }, 60000)
})
