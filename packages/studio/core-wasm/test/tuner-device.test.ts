import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {TunerDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {buildEffectProject, peakOf, renderEffect, renderEffectToggling} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

describe("Tuner", () => {
    it("saves calibration and display settings with the project", () => {
        const source = buildEffectProject(0.5, (graph, unit) => TunerDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.reference.setValue(432)
            box.threshold.setValue(-60)
            box.channel.setValue(2)
            box.smooth.setValue(0.7)
            box.view.setValue(2)
            box.spelling.setValue(1)
            box.showFrequency.setValue(true)
            box.autoFollow.setValue(false)
            box.historyCenter.setValue(57)
            box.historySpan.setValue(12)
        }))
        const restored = ProjectSkeleton.decode(ProjectSkeleton.encode(source)).boxGraph.boxes()
            .find(box => box instanceof TunerDeviceBox) as TunerDeviceBox
        expect(restored).toBeDefined()
        expect([restored.reference.getValue(), restored.threshold.getValue(), restored.channel.getValue(),
            restored.view.getValue(), restored.spelling.getValue(), restored.showFrequency.getValue(),
            restored.autoFollow.getValue(), restored.historyCenter.getValue(), restored.historySpan.getValue()])
            .toEqual([432, -60, 2, 2, 1, true, false, 57, 12])
        expect(restored.smooth.getValue()).toBeCloseTo(0.7)
    })

    it("passes audio unchanged, including when bypass changes during playback", async () => {
        const baseline = await renderEffect(buildEffectProject(0.5, (_source, unit) => unit), 120)
        let tuner!: TunerDeviceBox
        const source = buildEffectProject(0.5, (graph, unit) => tuner = TunerDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.reference.setValue(410)
            box.threshold.setValue(-80)
        }))
        const measured = await renderEffectToggling(source, () => tuner.enabled.setValue(false), {quanta: 120, toggleAt: 80})
        expect(peakOf(baseline)).toBeGreaterThan(0.01)
        expect(measured).toEqual(baseline)
    }, 120000)

    it("registers and broadcasts the detected frequency, confidence and level", async () => {
        let tuner!: TunerDeviceBox
        const source = buildEffectProject(0.05, (graph, unit) => tuner = TunerDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        }))
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        let dataPtr = 0
        for (let index = 0; index < engine.broadcast_count(); index++) {
            const ptr = engine.input_reserve(48)
            if (engine.broadcast_entry(index, ptr) === 0) {continue}
            const record = new DataView(memory.buffer, ptr, 48)
            const uuid = new Uint8Array(memory.buffer, ptr, 16) as UUID.Bytes
            if (UUID.equals(uuid, tuner.address.uuid) && record.getUint32(28, true) === 1 && record.getUint16(32, true) === 0) {
                expect(record.getUint32(24, true)).toBe(3)
                dataPtr = record.getUint32(20, true)
                engine.broadcast_set_active(index, 1)
            }
        }
        expect(dataPtr).not.toBe(0)
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < 120; quantum++) {engine.render()}
        const [frequency, confidence, level] = new Float32Array(memory.buffer, dataPtr, 3)
        // The harness plays middle C at A4=440 Hz.
        expect(Math.abs(1200 * Math.log2(frequency / 261.625565))).toBeLessThan(3)
        expect(confidence).toBeGreaterThan(0.95)
        expect(level).toBeGreaterThan(-40)
        expect(level).toBeLessThan(-20)
        source.beginTransaction(); tuner.threshold.setValue(-20); source.endTransaction()
        await sync.settle()
        for (let quantum = 0; quantum < 40; quantum++) {engine.render()}
        expect(Array.from(new Float32Array(memory.buffer, dataPtr, 2))).toEqual([0, 0])
        // Reference is a display/calibration parameter, not an audio pitch shifter.
        source.beginTransaction(); tuner.threshold.setValue(-55); tuner.reference.setValue(480); source.endTransaction()
        await sync.settle()
        for (let quantum = 0; quantum < 40; quantum++) {engine.render()}
        expect(new Float32Array(memory.buffer, dataPtr, 3)[0]).toBeCloseTo(frequency, 1)
    }, 120000)
})
