// Wiring + behaviour: a DattorroReverb audio-effect in a real unit's audio-fx chain adds a wet plate-reverb tail.
// With the wet path up the output differs from the dry-only setting (the reverb changes the signal) and stays
// finite/bounded — which only happens if the device is wired and its wet/dry/decay params applied. (The plate DSP
// is covered by dsp::dattorro; this proves the end-to-end chain.)
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {DattorroReverbDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, renderEffect, peakOf, allFinite} from "./helpers/effect-harness"

const dattorro = (wet: number, dry: number) =>
    buildEffectProject(0.3, (source, unit) => DattorroReverbDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.preDelay.setValue(10.0)
        box.bandwidth.setValue(0.9)
        box.inputDiffusion1.setValue(0.75)
        box.inputDiffusion2.setValue(0.625)
        box.decay.setValue(0.6)
        box.decayDiffusion1.setValue(0.7)
        box.decayDiffusion2.setValue(0.5)
        box.damping.setValue(0.1)
        box.excursionRate.setValue(0.5)
        box.excursionDepth.setValue(0.7)
        box.wet.setValue(wet)
        box.dry.setValue(dry)
    }))

const maxDiff = (a: Float32Array, b: Float32Array): number => {
    let max = 0
    for (let i = 0; i < a.length; i++) {max = Math.max(max, Math.abs(a[i] - b[i]))}
    return max
}

describe("dattorro reverb device", () => {
    it("audibly changes the signal when the wet path is up", async () => {
        const dryOnly = await renderEffect(dattorro(-100.0, 0.0)) // wet silenced -> dry only
        const wetted = await renderEffect(dattorro(0.0, 0.0))     // dry + full wet
        expect(allFinite(wetted)).toBe(true)
        expect(peakOf(wetted)).toBeLessThan(2.0)
        expect(maxDiff(wetted, dryOnly)).toBeGreaterThan(0.01) // the plate tail changes the output vs dry-only
    }, 30000)

    it("passes the dry signal when the wet path is silenced", async () => {
        const dryOnly = await renderEffect(dattorro(-100.0, 0.0))
        expect(allFinite(dryOnly)).toBe(true)
        expect(peakOf(dryOnly)).toBeGreaterThan(0.1)
    }, 30000)
})
