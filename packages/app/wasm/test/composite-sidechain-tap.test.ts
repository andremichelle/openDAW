// End-to-end proof of the AudioComposite INPUT TAP: a device INSIDE a composite can sidechain off the signal
// ENTERING the composite, which is a DIFFERENT signal than the device's own (post-distribution, post-prior-fx)
// input. Runs the real engine.wasm with real device plugins.
//
// Setup: an Apparat sine (loud) drives a composite. Its single entry is [StereoTool (volume -24 dB) ->
// Compressor]. So the compressor's MAIN input is the QUIET post-StereoTool signal, while the composite INPUT
// (the tap) is the LOUD sine. A compressor ducks its main by the DETECTOR level:
//   - sidechain -> composite INPUT (loud): detector sees the loud sine -> heavy gain reduction -> quiet output.
//   - no sidechain: detector self-follows the QUIET main -> little reduction -> louder output.
// So the tap working makes the output QUIETER. If the tap failed to resolve, the compressor would fall back to
// its main input and the two renders would match.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioEffectCompositeBox, AudioEffectCompositeCellBox, CompressorDeviceBox, StereoToolDeviceBox} from "@opendaw/studio-boxes"
import type {AudioUnitBox} from "@opendaw/studio-boxes"
import type {Box, BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject, renderEffect, peakOf, allFinite} from "./helpers/effect-harness"

// A composite on the unit's audio chain whose one entry reduces the signal (-24 dB) then compresses it. When
// `sidechainToInput` is set, the compressor detects on the composite INPUT instead of its own quiet main.
const compositeWithSidechainedCompressor = (sidechainToInput: boolean): BoxGraph =>
    buildEffectProject(0.8, (source: BoxGraph, unit: AudioUnitBox): Box => {
        const composite = AudioEffectCompositeBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.dry.setValue(Number.NEGATIVE_INFINITY) // wet only: the output IS the entry chain
            box.wet.setValue(0.0)
        })
        const entry = AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
            box.composite.refer(composite.entries)
            box.index.setValue(0)
        })
        // Reduce the entry signal so the compressor's MAIN input is far below the composite INPUT.
        StereoToolDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(entry.audioEffects)
            box.index.setValue(0)
            box.volume.setValue(-24.0)
            box.panning.setValue(0.0)
            box.stereo.setValue(0.0)
        })
        const compressor = CompressorDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(entry.audioEffects)
            box.index.setValue(1)
            box.lookahead.setValue(false)
            box.automakeup.setValue(false)
            box.autoattack.setValue(false)
            box.autorelease.setValue(false)
            box.inputgain.setValue(0.0)
            box.threshold.setValue(-40.0)
            box.ratio.setValue(20.0)
            box.knee.setValue(0.0)
            box.attack.setValue(1.0)
            box.release.setValue(50.0)
            box.makeup.setValue(0.0)
            box.mix.setValue(1.0)
        })
        // Point the compressor's sidechain at the composite's INPUT field (the tap vertex). The engine resolves
        // that address to the distributor's input copy — the loud sine entering the composite.
        if (sidechainToInput) {compressor.sideChain.refer(composite.input)}
        return composite
    })

describe("AudioComposite input tap", () => {
    it("a nested compressor ducks harder off the composite input than off its own reduced main", async () => {
        const tapped = await renderEffect(compositeWithSidechainedCompressor(true))
        const selfDetect = await renderEffect(compositeWithSidechainedCompressor(false))
        expect(allFinite(tapped)).toBe(true)
        expect(allFinite(selfDetect)).toBe(true)
        expect(peakOf(selfDetect)).toBeGreaterThan(0.0) // the reduced sine still sounds when barely compressed
        // The tap delivered the LOUD composite input as the detector, ducking the quiet main much harder.
        expect(peakOf(tapped)).toBeLessThan(peakOf(selfDetect) * 0.6)
    }, 30000)
})
