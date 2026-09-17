// Wiring + behaviour: a Reverb audio-effect in a real unit's audio-fx chain adds a wet reverb tail. A scriptable
// Apparat sine voices a note; with the wet path up the output carries more energy than the dry-only setting (the
// reverb adds ambience) and stays finite/bounded — which only happens if the device is wired and its wet/dry/decay
// params applied. (The FreeVerb DSP is covered by dsp::freeverb; this proves the end-to-end chain.)
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ReverbDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, renderEffect, peakOf, allFinite} from "./helpers/effect-harness"

// wet / dry in dB (-100 ~ silence for that path)
const reverb = (wet: number, dry: number) =>
    buildEffectProject(0.3, (source, unit) => ReverbDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.decay.setValue(0.7)
        box.preDelay.setValue(0.02)
        box.damp.setValue(0.3)
        box.filter.setValue(0.0)
        box.wet.setValue(wet)
        box.dry.setValue(dry)
    }))

const maxDiff = (a: Float32Array, b: Float32Array): number => {
    let max = 0
    for (let i = 0; i < a.length; i++) {max = Math.max(max, Math.abs(a[i] - b[i]))}
    return max
}

describe("reverb device", () => {
    it("audibly changes the signal when the wet path is up", async () => {
        const dryOnly = await renderEffect(reverb(-100.0, 0.0)) // wet silenced -> dry sine only
        const wetted = await renderEffect(reverb(0.0, 0.0))     // dry + full wet
        expect(allFinite(wetted)).toBe(true)
        expect(peakOf(wetted)).toBeLessThan(2.0)          // bounded
        expect(maxDiff(wetted, dryOnly)).toBeGreaterThan(0.01) // the reverb tail changes the output vs dry-only
    }, 30000)

    it("passes the dry signal when the wet path is silenced", async () => {
        const dryOnly = await renderEffect(reverb(-100.0, 0.0))
        expect(allFinite(dryOnly)).toBe(true)
        expect(peakOf(dryOnly)).toBeGreaterThan(0.1) // the ~0.3 sine passes through
    }, 30000)
})
