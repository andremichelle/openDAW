// Wiring + behaviour: a Maximizer audio-effect in a real unit's audio-fx chain lifts a below-threshold signal
// toward 0 dBFS (makeup gain) and, with look-ahead on (the box default), hard-clamps the output. A quiet Apparat
// sine (~0.1) driven through a low threshold comes out much louder yet bounded — which only happens if the device
// is wired and its threshold param + lookahead field applied.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {MaximizerDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, renderEffect, peakOf, allFinite} from "./helpers/effect-harness"

const maximizer = (gain: number, threshold: number) =>
    buildEffectProject(gain, (source, unit) => MaximizerDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.threshold.setValue(threshold)
        box.lookahead.setValue(true)
    }))

describe("maximizer device", () => {
    it("lifts a quiet signal toward 0 dBFS with makeup gain", async () => {
        const quiet = await renderEffect(maximizer(0.1, -18.0)) // ~0.1 peak sine, -18 dB threshold
        expect(allFinite(quiet)).toBe(true)
        expect(peakOf(quiet)).toBeGreaterThan(0.4) // makeup lifts ~0.1 well up (a maximizer maximizes loudness)
        expect(peakOf(quiet)).toBeLessThan(1.001)  // look-ahead clamps to unity
    }, 30000)

    it("keeps a loud signal bounded to unity with look-ahead", async () => {
        const loud = await renderEffect(maximizer(0.8, -6.0))
        expect(allFinite(loud)).toBe(true)
        expect(peakOf(loud)).toBeGreaterThan(0.5) // still loud
        expect(peakOf(loud)).toBeLessThan(1.001)  // never exceeds 0 dBFS (clamped)
    }, 30000)
})
