// #79: toggling the compressor's lookahead mid-playback must not click. Lookahead adds a 5ms delay and (in the
// buggy version) its ring buffers were frozen while disabled, so enabling read stale/zero content and the output
// jumped. We render a steady sine through a compressing Compressor, flip `lookahead` on at quantum 24, and assert
// the left channel stays continuous across the toggle (no sample-to-sample step far above the steady-state slope).
import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {CompressorDeviceBox} from "@opendaw/studio-boxes"
import {allFinite, buildEffectProject, leftChannel, maxStep, renderEffectToggling} from "./helpers/effect-harness"

const compressorProject = (initialLookahead: boolean): { source: ReturnType<typeof buildEffectProject>, box: CompressorDeviceBox } => {
    let captured: Option<CompressorDeviceBox> = Option.None
    const source = buildEffectProject(0.8, (src, unit) => {
        const box = CompressorDeviceBox.create(src, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.lookahead.setValue(initialLookahead)
            box.automakeup.setValue(false)
            box.autoattack.setValue(false)
            box.autorelease.setValue(false)
            box.inputgain.setValue(0.0)
            box.threshold.setValue(-30.0)
            box.ratio.setValue(8.0)
            box.knee.setValue(0.0)
            box.attack.setValue(1.0)
            box.release.setValue(50.0)
            box.makeup.setValue(0.0)
            box.mix.setValue(1.0)
        })
        captured = Option.wrap(box)
        return box
    })
    return {source, box: captured.unwrap()}
}

describe("compressor lookahead toggle", () => {
    const toggleAt = 24
    const assertContinuous = (out: Float32Array) => {
        expect(allFinite(out)).toBe(true)
        const left = leftChannel(out)
        const steadyStep = maxStep(left, RenderQuantum * 8, RenderQuantum * 20)
        const toggleStep = maxStep(left, RenderQuantum * (toggleAt - 2), RenderQuantum * (toggleAt + 6))
        // A click is a hard discontinuity; the continuous sine's steady step bounds the acceptable delta.
        expect(toggleStep).toBeLessThan(steadyStep * 3)
    }

    it("does not click when lookahead is switched ON during playback", async () => {
        const {source, box} = compressorProject(false)
        assertContinuous(await renderEffectToggling(source, () => box.lookahead.setValue(true), {quanta: 48, toggleAt}))
    }, 30000)

    it("does not click when lookahead is switched OFF during playback", async () => {
        const {source, box} = compressorProject(true)
        assertContinuous(await renderEffectToggling(source, () => box.lookahead.setValue(false), {quanta: 48, toggleAt}))
    }, 30000)
})
