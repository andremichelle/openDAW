// Repro of the browser finding: a Convolver INSERTED into a playing unit silenced the chain until an
// unrelated rebuild. Renders a unit without the effect, inserts the ConvolverDeviceBox mid-playback
// (live edit sync), and asserts audio KEEPS flowing. Dattorro as control.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ConvolverDeviceBox, DattorroReverbDeviceBox} from "@opendaw/studio-boxes"
import type {Box, BoxGraph} from "@opendaw/lib-box"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {buildEffectProject, peakOf, allFinite} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const renderInserting = async (insert: (source: BoxGraph, unit: AudioUnitBox) => Box): Promise<{before: Float32Array, after: Float32Array}> => {
    let unitBox: AudioUnitBox | null = null
    const source = buildEffectProject(0.3, (_source, unit) => {
        unitBox = unit
        return unit // no effect yet; harness just needs a box back
    })
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const quanta = 96
    const insertAt = 24
    const out = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        if (q === insertAt) {
            source.beginTransaction()
            insert(source, unitBox!)
            source.endTransaction()
            await sync.settle()
        }
        engine.render()
        const enginePtr = engine.output_ptr()
        out.set(new Float32Array(memory.buffer, enginePtr, len), q * len)
    }
    return {before: out.subarray(0, insertAt * len), after: out.subarray((insertAt + 8) * len)}
}

describe("convolver live insertion", () => {
    it("inserting a convolver mid-playback keeps the audio flowing", async () => {
        const {before, after} = await renderInserting((source, unit) =>
            ConvolverDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
            }))
        expect(allFinite(after)).toBe(true)
        expect(peakOf(before)).toBeGreaterThan(0.01)
        expect(peakOf(after)).toBeGreaterThan(0.01)
    }, 30000)

    it("control: inserting a dattorro mid-playback keeps the audio flowing", async () => {
        const {before, after} = await renderInserting((source, unit) =>
            DattorroReverbDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
            }))
        expect(allFinite(after)).toBe(true)
        expect(peakOf(before)).toBeGreaterThan(0.01)
        expect(peakOf(after)).toBeGreaterThan(0.01)
    }, 30000)
})
