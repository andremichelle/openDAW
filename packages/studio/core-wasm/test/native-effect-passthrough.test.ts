// A native plugin effect has no device in the browser engine: the chain skips it, the audio passes bit-identical
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {NativeEffectBox} from "@opendaw/studio-boxes"
import {allFinite, buildEffectProject, peakOf, renderEffect} from "./helpers/effect-harness"

describe("native effect in the browser engine", () => {
    it("passes the audio through unchanged and keeps its fields", async () => {
        const state = new Int8Array(4096).map((_, index) => (index * 31) & 0xff)
        const withEffect = buildEffectProject(0.5, (source, unit) => NativeEffectBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.format.setValue("vst3")
            box.pluginId.setValue("ABCDEF019182FAEB4175526541424C36")
            box.state.setValue(state)
        }))
        const without = buildEffectProject(0.5, (_source, unit) => unit)
        const passed = await renderEffect(withEffect)
        const reference = await renderEffect(without)
        expect(allFinite(passed)).toBe(true)
        expect(peakOf(reference)).toBeGreaterThan(0.4)
        expect(Array.from(passed)).toEqual(Array.from(reference))
        const box = withEffect.boxes().find(box => box instanceof NativeEffectBox) as NativeEffectBox
        expect(Array.from(box.state.getValue())).toEqual(Array.from(state))
    }, 30000)
})
