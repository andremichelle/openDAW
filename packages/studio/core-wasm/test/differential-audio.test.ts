// DIFFERENTIAL audio assertions: instead of checking wiring (node ids, edges, param-push counts), these render
// the REAL master output and compare the actual samples. They prove the DSP behaves: the engine is deterministic,
// an effect's bypass actually changes the sound, and disabling then re-enabling a plugin returns to BIT-IDENTICAL
// output (the edge-only contract proven by audio, not by a proxy counter). Metronome off + real samples, so the
// signal under test is the instruments, not the click.

import {describe, expect, it} from "vitest"
import {DeviceBoxUtils} from "@opendaw/studio-adapters"
import {buildProject, maxDiff} from "./helpers/render-harness"

describe("differential audio", () => {
    it("the engine renders deterministically (same state -> bit-identical output)", async () => {
        const {capture} = await buildProject()
        const first = capture(64)
        const second = capture(64)
        expect(maxDiff(first, second)).toBe(0) // stop/play rewind is clean; no hidden nondeterminism
        expect(Math.max(...first.map(Math.abs))).toBeGreaterThan(0.1) // and it is real signal, not silence
    }, 30000)

    it("an effect's bypass changes the mix, and re-enabling restores it bit-for-bit", async () => {
        const {source, sync, capture} = await buildProject()
        const audioEffects = source.boxes().filter(DeviceBoxUtils.isEffectDeviceBox)
            .filter(box => box.tags.deviceType === "audio-effect")
        expect(audioEffects.length).toBeGreaterThan(0)

        const enabled = capture(64)
        const setAll = async (value: boolean): Promise<void> => {
            source.beginTransaction()
            audioEffects.forEach(effect => effect.enabled.setValue(value))
            source.endTransaction()
            await sync.settle()
        }
        await setAll(false)
        const bypassed = capture(64)
        await setAll(true)
        const restored = capture(64)

        expect(maxDiff(enabled, bypassed)).toBeGreaterThan(0.01) // the effects are really in the path (bypass audible)
        expect(maxDiff(enabled, restored)).toBe(0) // re-enabling is a PERFECT edge-only restore (no glide, no reset)
    }, 30000)

    it("disabling composite children (Playfield slots) changes the mix, re-enabling restores it bit-for-bit", async () => {
        const {source, sync, capture} = await buildProject()
        const slots = source.boxes().filter(DeviceBoxUtils.isInstrumentDeviceBox).filter(box => box.name === "PlayfieldSampleBox")
        expect(slots.length).toBeGreaterThan(0)

        const withSlots = capture(128)
        const setAll = async (value: boolean): Promise<void> => {
            source.beginTransaction()
            slots.forEach(slot => slot.enabled.setValue(value))
            source.endTransaction()
            await sync.settle()
        }
        await setAll(false)
        const noSlots = capture(128)
        await setAll(true)
        const restored = capture(128)

        expect(maxDiff(withSlots, noSlots)).toBeGreaterThan(0.01) // the slots are summed in (disabling them is audible)
        expect(maxDiff(withSlots, restored)).toBe(0) // re-enabling each slot is a perfect edge-only restore
    }, 30000)
})
