// Live errors 1223/1224: a Vocoder switched to "external" with a Revamp after it as its sidechain feeds its own
// output back into its modulator. The Vocoder's output scales with the modulator, so the loop grows ~1.6x per
// quantum until it overflows, which used to fail the engine. Now the engine flags the loop once, and a device on
// the loop that overflows is silenced and reset instead. A device outside any loop still fails the engine.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {RevampDeviceBox, VocoderDeviceBox} from "@opendaw/studio-boxes"
import type {EngineNotice} from "@opendaw/studio-adapters"
import {buildEffectProject, peakOf} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {takeNotices, takeReportMessage} from "../src/engine-exports"

const QUANTA = 750 // ~2 s at 48 kHz, the time the restarted engine took to fail

type Rendered = {
    output: Float32Array
    notices: ReadonlyArray<EngineNotice>
    reports: ReadonlyArray<string>
    vocoder: string
    revamp: string
}

const render = async (revampIndex: number, vocoderIndex: number, gainDb: number): Promise<Rendered> => {
    let vocoder = "", revamp = ""
    const source = buildEffectProject(0.3, (graph, unit) => {
        const revampBox = RevampDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(revampIndex)
        })
        revamp = UUID.toString(revampBox.address.uuid)
        const vocoderBox = VocoderDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(vocoderIndex)
            box.gain.setValue(gainDb)
            box.modulatorSource.setValue("external")
            box.sideChain.refer(revampBox)
        })
        vocoder = UUID.toString(vocoderBox.address.uuid)
        return vocoderBox
    })
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const notices: Array<EngineNotice> = [...takeNotices(engine, memory)]
    const reports: Array<string> = []
    const length = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const output = new Float32Array(QUANTA * length)
    for (let quantum = 0; quantum < QUANTA; quantum++) {
        engine.render()
        output.set(new Float32Array(memory.buffer, engine.output_ptr(), length), quantum * length)
        notices.push(...takeNotices(engine, memory))
        takeReportMessage(engine, memory).ifSome(message => reports.push(message))
    }
    return {output, notices, reports, vocoder, revamp}
}

const allFinite = (buffer: Float32Array): boolean => buffer.every(sample => Number.isFinite(sample))

describe("vocoder with a Revamp sidechain (live errors 1223/1224)", () => {
    for (const gainDb of [0.0, 20.0]) {
        it(`Revamp after the Vocoder closes a loop, gain ${gainDb} dB: flagged once, reset on overflow, never fatal`, async () => {
            const {output, notices, reports, vocoder, revamp} = await render(1, 0, gainDb)
            expect(reports).toEqual([])
            expect(allFinite(output)).toBe(true)
            expect(notices.filter(notice => notice.type === "sidechain-loop"))
                .toEqual([{type: "sidechain-loop", device: vocoder, source: revamp}])
            const overflows = notices.filter(notice => notice.type === "non-finite")
            expect(overflows.length).toBe(1)
            expect([vocoder, revamp]).toContain(overflows[0].device)
            expect(peakOf(output.subarray(output.length >> 1))).toBeGreaterThan(0.0) // the loop restarts after its reset
        }, 60000)
        it(`Revamp before the Vocoder closes no loop, gain ${gainDb} dB: no notice, finite`, async () => {
            const {output, notices, reports} = await render(0, 1, gainDb)
            expect(reports).toEqual([])
            expect(notices).toEqual([])
            expect(allFinite(output)).toBe(true)
        }, 60000)
    }
})
