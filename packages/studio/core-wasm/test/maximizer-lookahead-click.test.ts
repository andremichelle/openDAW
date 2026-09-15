// #79 follow-up: the Maximizer has its own look-ahead (a delay ring + brickwall clamp). Toggling it mid-playback
// clicks for the same reason the compressor did: the ring only advances while look-ahead is on (so it freezes /
// goes stale when off), plus the look-ahead-frames latency step. We render a steady sine through a limiting
// Maximizer, flip `lookahead` at quantum 24, and assert the left channel stays continuous across the toggle.
import {describe, expect, it} from "vitest"
import {Option, UUID} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {MaximizerDeviceBox} from "@opendaw/studio-boxes"
import {allFinite, buildEffectProject, leftChannel, maxStep, renderEffectToggling} from "./helpers/effect-harness"

const maximizerProject = (initialLookahead: boolean): { source: ReturnType<typeof buildEffectProject>, box: MaximizerDeviceBox } => {
    let captured: Option<MaximizerDeviceBox> = Option.None
    const source = buildEffectProject(0.8, (src, unit) => {
        const box = MaximizerDeviceBox.create(src, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.lookahead.setValue(initialLookahead)
            box.threshold.setValue(-12.0) // well below the 0.8 sine, so the limiter is actively reducing
        })
        captured = Option.wrap(box)
        return box
    })
    return {source, box: captured.unwrap()}
}

describe("maximizer lookahead toggle", () => {
    const toggleAt = 24
    const assertContinuous = (out: Float32Array) => {
        expect(allFinite(out)).toBe(true)
        const left = leftChannel(out)
        const steadyStep = maxStep(left, RenderQuantum * 8, RenderQuantum * 20)
        const toggleStep = maxStep(left, RenderQuantum * (toggleAt - 2), RenderQuantum * (toggleAt + 6))
        expect(toggleStep).toBeLessThan(steadyStep * 3)
    }

    it("does not click when lookahead is switched OFF during playback", async () => {
        const {source, box} = maximizerProject(true)
        assertContinuous(await renderEffectToggling(source, () => box.lookahead.setValue(false), {quanta: 48, toggleAt}))
    }, 30000)

    it("does not click when lookahead is switched ON during playback", async () => {
        const {source, box} = maximizerProject(false)
        assertContinuous(await renderEffectToggling(source, () => box.lookahead.setValue(true), {quanta: 48, toggleAt}))
    }, 30000)
})
