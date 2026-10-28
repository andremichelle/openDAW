import {describe, expect, it} from "vitest"
import {asDefined, asInstanceOf, UUID} from "@opendaw/lib-std"
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
            box.view.setValue(1)
            box.strobe.setValue(true)
            box.showFrequency.setValue(true)
            box.autoFollow.setValue(false)
            box.historyCenter.setValue(57)
            box.historySpan.setValue(12)
        }))
        const restored = asInstanceOf(asDefined(ProjectSkeleton.decode(ProjectSkeleton.encode(source)).boxGraph.boxes()
            .find(box => box instanceof TunerDeviceBox)), TunerDeviceBox)
        expect([restored.reference.getValue(), restored.view.getValue(), restored.strobe.getValue(), restored.showFrequency.getValue(),
            restored.autoFollow.getValue(), restored.historyCenter.getValue(), restored.historySpan.getValue()])
            .toEqual([432, 1, true, true, false, 57, 12])
    })

    it("passes audio unchanged, including when bypass changes during playback", async () => {
        const baseline = await renderEffect(buildEffectProject(0.5, (_source, unit) => unit), 120)
        const source = buildEffectProject(0.5, (graph, unit) => TunerDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            box.reference.setValue(410)
        }))
        const tuner = asInstanceOf(asDefined(source.boxes().find(box => box instanceof TunerDeviceBox)), TunerDeviceBox)
        const measured = await renderEffectToggling(source, () => tuner.enabled.setValue(false), {quanta: 120, toggleAt: 80})
        expect(peakOf(baseline)).toBeGreaterThan(0.01)
        expect(measured).toEqual(baseline)
    }, 120000)

    it("registers and broadcasts the detected frequency, confidence and level", async () => {
        const source = buildEffectProject(0.05, (graph, unit) => TunerDeviceBox.create(graph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        }))
        const tuner = asInstanceOf(asDefined(source.boxes().find(box => box instanceof TunerDeviceBox)), TunerDeviceBox)
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
        source.beginTransaction(); tuner.reference.setValue(480); source.endTransaction()
        await sync.settle()
        for (let quantum = 0; quantum < 40; quantum++) {engine.render()}
        expect(new Float32Array(memory.buffer, dataPtr, 3)[0]).toBeCloseTo(frequency, 1)
    }, 120000)
})
