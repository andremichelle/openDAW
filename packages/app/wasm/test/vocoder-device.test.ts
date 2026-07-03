// Wiring + behaviour: a Vocoder audio-effect in a real unit's audio-fx chain. In "self" mode it is a multi-band
// gate on the carrier, so a full-wet render differs from dry-only and stays finite/bounded. In "noise-pink" mode
// the carrier is imprinted with the noise modulator and still produces audible, finite output. (The filter-bank
// DSP is covered by dsp::vocoder; this proves the end-to-end chain: params, the modulatorSource string field, and
// bandCount all reach the device.)
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {VocoderDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, renderEffect, peakOf, allFinite} from "./helpers/effect-harness"

const vocoder = (mix: number, source: string) =>
    buildEffectProject(0.3, (root, unit) => VocoderDeviceBox.create(root, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.carrierMinFreq.setValue(100.0)
        box.carrierMaxFreq.setValue(12000.0)
        box.modulatorMinFreq.setValue(100.0)
        box.modulatorMaxFreq.setValue(12000.0)
        box.qMin.setValue(2.0)
        box.qMax.setValue(20.0)
        box.envAttack.setValue(5.0)
        box.envRelease.setValue(30.0)
        box.gain.setValue(0.0)
        box.mix.setValue(mix)
        box.bandCount.setValue(16)
        box.modulatorSource.setValue(source)
    }))

const maxDiff = (a: Float32Array, b: Float32Array): number => {
    let max = 0
    for (let i = 0; i < a.length; i++) {max = Math.max(max, Math.abs(a[i] - b[i]))}
    return max
}

describe("vocoder device", () => {
    it("self mode gates the carrier — full-wet differs from dry and stays bounded", async () => {
        const dry = await renderEffect(vocoder(0.0, "self")) // mix 0 -> dry carrier only
        const wet = await renderEffect(vocoder(1.0, "self")) // full wet -> multi-band gated
        expect(allFinite(wet)).toBe(true)
        expect(peakOf(wet)).toBeLessThan(16.0) // a resonant multi-band gate boosts, but must stay bounded (not inf)
        expect(maxDiff(wet, dry)).toBeGreaterThan(0.01) // the band gate changes the signal vs dry-only
    }, 30000)

    it("noise-pink mode imprints the noise modulator and is audible + finite", async () => {
        const wet = await renderEffect(vocoder(1.0, "noise-pink"))
        expect(allFinite(wet)).toBe(true)
        expect(peakOf(wet)).toBeGreaterThan(1e-3)
        expect(peakOf(wet)).toBeLessThan(16.0) // a resonant multi-band gate boosts, but must stay bounded (not inf)
    }, 30000)
})
