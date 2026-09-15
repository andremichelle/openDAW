// Wiring + behaviour: a Compressor audio-effect in a real unit's audio-fx chain reduces the level of a signal
// above threshold. A loud Apparat sine driven through a low threshold + high ratio comes out quieter than the
// same signal at ratio 1 (no compression) — which only happens if the device is wired and its threshold / ratio
// params applied. (The CTAGDRC DSP internals are covered by dsp::ctagdrc; this proves the end-to-end chain.)
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {CompressorDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, renderEffect, peakOf, allFinite} from "./helpers/effect-harness"

const compressor = (ratio: number) =>
    buildEffectProject(0.8, (source, unit) => CompressorDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.lookahead.setValue(false)
        box.automakeup.setValue(false)
        box.autoattack.setValue(false)
        box.autorelease.setValue(false)
        box.inputgain.setValue(0.0)
        box.threshold.setValue(-30.0)
        box.ratio.setValue(ratio)
        box.knee.setValue(0.0)
        box.attack.setValue(1.0)
        box.release.setValue(50.0)
        box.makeup.setValue(0.0)
        box.mix.setValue(1.0)
    }))

describe("compressor device", () => {
    it("reduces a loud signal above threshold at a high ratio", async () => {
        const compressed = await renderEffect(compressor(20.0))
        const flat = await renderEffect(compressor(1.0)) // ratio 1 = no compression (reference)
        expect(allFinite(compressed)).toBe(true)
        expect(peakOf(compressed)).toBeGreaterThan(0.0)               // still sounds
        expect(peakOf(compressed)).toBeLessThan(peakOf(flat) * 0.8)   // clearly reduced vs uncompressed
    }, 30000)

    it("is roughly transparent at ratio 1", async () => {
        const flat = await renderEffect(compressor(1.0))
        expect(allFinite(flat)).toBe(true)
        expect(peakOf(flat)).toBeGreaterThan(0.5) // ~the 0.8 sine passes (no reduction, no makeup)
    }, 30000)
})
