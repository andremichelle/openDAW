// End-to-end AUDIBLE behaviour of the AudioComposite, through the real engine.wasm. These cover what only a
// full render proves — the places node-level tests kept missing (dry/wet routing, the empty-composite bypass,
// entry mute, the stereo split, per-entry pan). An Apparat sine (equal L/R) drives every case.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioEffectCompositeBox, AudioEffectCompositeCellBox, StereoCompositeBox, StereoToolDeviceBox} from "@opendaw/studio-boxes"
import type {AudioUnitBox} from "@opendaw/studio-boxes"
import type {Box, BoxGraph} from "@opendaw/lib-box"
import {buildEffectProject, renderEffect, renderEffectToggling, peakOf, allFinite} from "./helpers/effect-harness"

const LEN = 256 // engine output_len: planar L|R, 128 each (matches load-full-engine's quantum)
const channelPeaks = (out: Float32Array): [number, number] => {
    const half = LEN / 2
    let left = 0, right = 0
    for (let base = 0; base + LEN <= out.length; base += LEN) {
        for (let i = 0; i < half; i++) {left = Math.max(left, Math.abs(out[base + i]))}
        for (let i = half; i < LEN; i++) {right = Math.max(right, Math.abs(out[base + i]))}
    }
    return [left, right]
}

// A silent effect (StereoTool at the -72 dB floor) so a WET branch differs sharply from the DRY input.
const silencer = (source: BoxGraph, hostField: AudioEffectCompositeCellBox["audioEffects"]) =>
    StereoToolDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(hostField)
        box.index.setValue(0)
        box.volume.setValue(-72.0)
        box.panning.setValue(0.0)
        box.stereo.setValue(0.0)
    })

describe("AudioComposite (audible)", () => {
    it("an EMPTY composite passes the signal through", async () => {
        const out = await renderEffect(buildEffectProject(0.3, (source: BoxGraph, unit: AudioUnitBox): Box =>
            AudioEffectCompositeBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
            })))
        expect(allFinite(out)).toBe(true)
        expect(peakOf(out)).toBeGreaterThan(0.1) // inserting a fresh composite must not kill the chain
    }, 30000)

    // dry -inf / wet 0 dB (the default) routes the ENTRY chain; dry 0 / wet -inf routes the raw INPUT. With a
    // silencing entry the two are opposites, which proves the mix actually routes both paths.
    const dryWet = (dry: number, wet: number): BoxGraph =>
        buildEffectProject(0.3, (source: BoxGraph, unit: AudioUnitBox): Box => {
            const composite = AudioEffectCompositeBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.dry.setValue(dry)
                box.wet.setValue(wet)
            })
            const entry = AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            silencer(source, entry.audioEffects) // the wet branch is silenced
            return composite
        })

    it("routes the DRY input and the WET entry chain distinctly", async () => {
        const dryOnly = await renderEffect(dryWet(0.0, Number.NEGATIVE_INFINITY))
        const wetOnly = await renderEffect(dryWet(Number.NEGATIVE_INFINITY, 0.0))
        expect(allFinite(dryOnly)).toBe(true)
        expect(allFinite(wetOnly)).toBe(true)
        expect(peakOf(dryOnly)).toBeGreaterThan(0.1)  // dry = the raw sine
        expect(peakOf(wetOnly)).toBeLessThan(1e-2)     // wet = the silenced entry
    }, 30000)

    // One passthrough entry, default dry/wet (output = wet = the entry). Muting the entry silences the whole
    // composite; unmuted it sounds.
    const oneEntry = (mute: boolean): BoxGraph =>
        buildEffectProject(0.3, (source: BoxGraph, unit: AudioUnitBox): Box => {
            const composite = AudioEffectCompositeBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
            })
            AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
                box.mute.setValue(mute)
            })
            return composite
        })

    it("an entry's MUTE silences its branch", async () => {
        const audible = await renderEffect(oneEntry(false))
        const muted = await renderEffect(oneEntry(true))
        expect(peakOf(audible)).toBeGreaterThan(0.1) // the entry passes the sine
        expect(peakOf(muted)).toBeLessThan(1e-3)     // muting drops it from the wet sum
    }, 30000)

    it("an entry's PAN moves it in the stereo field", async () => {
        const out = await renderEffect(buildEffectProject(0.3, (source: BoxGraph, unit: AudioUnitBox): Box => {
            const composite = AudioEffectCompositeBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
            })
            AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
                box.pan.setValue(1.0) // hard right
            })
            return composite
        }))
        const [left, right] = channelPeaks(out)
        expect(right).toBeGreaterThan(0.1) // the right channel sounds
        expect(left).toBeLessThan(1e-3)    // the left is panned away — proves the entry strip pans
    }, 30000)

    // The reported bug: mute / pan / solo set BEFORE load (initial dump) work, but TOGGLING an entry control
    // after load does nothing. These flip the field mid-playback through the incremental sync.
    const buildOneEntry = (): {source: BoxGraph, entry: AudioEffectCompositeCellBox} => {
        let cell: AudioEffectCompositeCellBox | undefined
        const source = buildEffectProject(0.3, (src: BoxGraph, unit: AudioUnitBox): Box => {
            const composite = AudioEffectCompositeBox.create(src, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
            })
            cell = AudioEffectCompositeCellBox.create(src, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            return composite
        })
        if (cell === undefined) {throw new Error("entry not built")}
        return {source, entry: cell}
    }

    const settled = (out: Float32Array, fromQuantum: number, toQuantum: number): Float32Array =>
        out.subarray(fromQuantum * LEN, toQuantum * LEN)

    it("toggling an entry's MUTE after load silences it", async () => {
        const {source, entry} = buildOneEntry()
        const out = await renderEffectToggling(source, () => entry.mute.setValue(true), {quanta: 48, toggleAt: 24})
        expect(peakOf(settled(out, 4, 20))).toBeGreaterThan(0.1)   // audible before the toggle
        expect(peakOf(settled(out, 40, 48))).toBeLessThan(1e-3)    // silent after it
    }, 30000)

    it("toggling an entry's PAN hard right after load moves it off the left", async () => {
        const {source, entry} = buildOneEntry()
        const out = await renderEffectToggling(source, () => entry.pan.setValue(1.0), {quanta: 48, toggleAt: 24})
        expect(channelPeaks(settled(out, 4, 20))[0]).toBeGreaterThan(0.1) // left audible before
        expect(channelPeaks(settled(out, 40, 48))[0]).toBeLessThan(1e-3)  // left gone after
    }, 30000)

    it("toggling both DRY and WET off after load silences the composite", async () => {
        let composite: AudioEffectCompositeBox | undefined
        const source = buildEffectProject(0.3, (src: BoxGraph, unit: AudioUnitBox): Box => {
            const box = AudioEffectCompositeBox.create(src, UUID.generate(), b => {
                b.host.refer(unit.audioEffects)
                b.index.setValue(0)
            }) // default dry -inf / wet 0 dB: audible through the entry
            AudioEffectCompositeCellBox.create(src, UUID.generate(), b => {
                b.composite.refer(box.entries)
                b.index.setValue(0)
            })
            composite = box
            return box
        })
        if (composite === undefined) {throw new Error("composite not built")}
        const target = composite
        const out = await renderEffectToggling(source, () => {
            target.wet.setValue(Number.NEGATIVE_INFINITY)
            target.dry.setValue(Number.NEGATIVE_INFINITY)
        }, {quanta: 48, toggleAt: 24})
        expect(peakOf(settled(out, 4, 20))).toBeGreaterThan(0.1) // audible before
        expect(peakOf(settled(out, 40, 48))).toBeLessThan(1e-3)  // dead silent after both are off
    }, 30000)

    it("two entries with effects, dry AND wet at -inf, is dead silent", async () => {
        // The reported screenshot: FX Composite, two populated entries, dry = wet = -inf dB. Output must be silent.
        const out = await renderEffect(buildEffectProject(0.3, (source: BoxGraph, unit: AudioUnitBox): Box => {
            const composite = AudioEffectCompositeBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.dry.setValue(Number.NEGATIVE_INFINITY)
                box.wet.setValue(Number.NEGATIVE_INFINITY)
            })
            const entryA = AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0)
            })
            const entryB = AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(1)
            })
            StereoToolDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(entryA.audioEffects); box.index.setValue(0); box.volume.setValue(0.0)
            })
            StereoToolDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(entryB.audioEffects); box.index.setValue(0); box.volume.setValue(0.0)
            })
            return composite
        }))
        expect(peakOf(out)).toBeLessThan(1e-3)
    }, 30000)

    it("a STEREO split routes each channel to its own entry", async () => {
        // Two entries; entry 1 (the RIGHT branch) is muted. The sine is equal L/R, so muting the right branch
        // must silence the right channel while the left (entry 0) survives.
        const out = await renderEffect(buildEffectProject(0.3, (source: BoxGraph, unit: AudioUnitBox): Box => {
            const composite = StereoCompositeBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
            })
            AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(0) // LEFT branch
            })
            AudioEffectCompositeCellBox.create(source, UUID.generate(), box => {
                box.composite.refer(composite.entries)
                box.index.setValue(1) // RIGHT branch
                box.mute.setValue(true)
            })
            return composite
        }))
        const [left, right] = channelPeaks(out)
        expect(left).toBeGreaterThan(0.1) // the left branch (entry 0) still sounds
        expect(right).toBeLessThan(1e-3)  // muting the right branch (entry 1) silenced the right channel
    }, 30000)
})
