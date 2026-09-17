// Wiring + behaviour: a Fold (wavefolder) audio-effect in a real unit's audio-fx chain must oversample, fold,
// and downsample its input. A scriptable Apparat sine (~0.3 peak) voices a note; a high drive folds the signal
// back on itself (bounded, harmonically richer), which only happens if the device is wired and its drive param +
// over-sampling field applied. A low-drive render is near pass-through. Every over-sampling factor stays finite.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {FoldDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, renderEffect, peakOf, allFinite} from "./helpers/effect-harness"

// drive in dB, over-sampling index (0/1/2 -> 2x/4x/8x)
const fold = (drive: number, overSampling: number) =>
    buildEffectProject(0.3, (source, unit) => FoldDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.drive.setValue(drive)
        box.overSampling.setValue(overSampling)
        box.volume.setValue(0.0)
    }))

describe("fold device", () => {
    it("folds a driven signal into a bounded, richer waveform", async () => {
        const out = await renderEffect(fold(30.0, 0))
        expect(allFinite(out)).toBe(true)
        expect(peakOf(out)).toBeGreaterThan(0.3) // it sounds and the fold lifts the level
        expect(peakOf(out)).toBeLessThan(1.2)    // the triangle wrap keeps it bounded
    }, 30000)

    it("is near pass-through at low drive", async () => {
        const out = await renderEffect(fold(0.0, 0))
        expect(allFinite(out)).toBe(true)
        expect(peakOf(out)).toBeGreaterThan(0.1)
        expect(peakOf(out)).toBeLessThan(0.6) // ~0.3 sine barely folded
    }, 30000)

    it("stays finite at every over-sampling factor", async () => {
        for (const overSampling of [0, 1, 2]) {
            const out = await renderEffect(fold(24.0, overSampling), 8)
            expect(allFinite(out), `factor index ${overSampling}`).toBe(true)
            expect(peakOf(out)).toBeGreaterThan(0.1)
        }
    }, 30000)
})
