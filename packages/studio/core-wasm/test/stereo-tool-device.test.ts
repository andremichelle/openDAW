// Wiring + behaviour: a StereoTool audio-effect in a real unit's audio-fx chain applies its 2x2 stereo matrix.
// A scriptable Apparat sine voices a note (equal on L and R). At default (unity, centre) both channels pass
// through; panned hard right, the left channel goes silent — which only happens if the device is wired and its
// volume / panning params applied. Swap on a mono source is inaudible, so panning is the discriminator.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {StereoToolDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, renderEffect, allFinite} from "./helpers/effect-harness"

const stereoTool = (panning: number) =>
    buildEffectProject(0.3, (source, unit) => StereoToolDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.volume.setValue(0.0) // 0 dB, unity
        box.panning.setValue(panning)
        box.stereo.setValue(0.0)
    }))

// Peak of the left / right planar half of each quantum (output is planar L|R per render quantum of length `len`).
const channelPeaks = (out: Float32Array, len: number): [number, number] => {
    const half = len / 2
    let left = 0, right = 0
    for (let base = 0; base + len <= out.length; base += len) {
        for (let i = 0; i < half; i++) {left = Math.max(left, Math.abs(out[base + i]))}
        for (let i = half; i < len; i++) {right = Math.max(right, Math.abs(out[base + i]))}
    }
    return [left, right]
}
const LEN = 256 // engine output_len (planar L|R, 128 each) — matches load-full-engine's quantum

describe("stereo tool device", () => {
    it("passes both channels through at unity / centre", async () => {
        const out = await renderEffect(stereoTool(0.0))
        expect(allFinite(out)).toBe(true)
        const [left, right] = channelPeaks(out, LEN)
        expect(left).toBeGreaterThan(0.1)
        expect(right).toBeGreaterThan(0.1)
    }, 30000)

    it("silences the left channel when panned hard right", async () => {
        const out = await renderEffect(stereoTool(1.0))
        expect(allFinite(out)).toBe(true)
        const [left, right] = channelPeaks(out, LEN)
        expect(right).toBeGreaterThan(0.1)   // the right channel still sounds
        expect(left).toBeLessThan(1e-4)      // the left channel is silenced
    }, 30000)
})
