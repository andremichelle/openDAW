// Surgeon in the FULL engine: it plays by itself while the transport runs, from the patterns stored in its box.
import {describe, expect, it} from "vitest"
import {int, Procedure, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, SurgeonDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLES_PER_BAR = 3840 * 25 // 48k, 120 bpm, 960 per quarter

const render = async (bars: int, setup: Procedure<SurgeonDeviceBox>): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    SurgeonDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        setup(box)
    })
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    const quanta = Math.ceil(bars * SAMPLES_PER_BAR / half)
    const left = new Float32Array(quanta * half)
    for (let index = 0; index < quanta; index++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), index * half)
    }
    sync.close()
    return left
}

const rms = (samples: Float32Array, from: int, to: int): number => {
    let sum = 0.0
    for (let index = from; index < to; index++) {sum += samples[index] * samples[index]}
    return Math.sqrt(sum / (to - from))
}

describe("Surgeon in the full engine", () => {
    it("plays its default pattern by itself", async () => {
        const output = await render(2, () => {})
        expect(output.every(Number.isFinite)).toBe(true)
        expect(rms(output, 0, SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
        expect(rms(output, SAMPLES_PER_BAR, 2 * SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
    }, 300000)
    it("is silent when its slot is off", async () => {
        const output = await render(1, box => box.slot.setValue(-1))
        expect(rms(output, 0, SAMPLES_PER_BAR)).toBe(0.0)
    }, 300000)
    it("plays the pattern its slot names, from the stored values", async () => {
        const first = await render(1, () => {})
        const again = await render(1, () => {})
        expect(again.every((value, index) => value === first[index])).toBe(true)
        const second = await render(1, box => {
            box.slot.setValue(1)
            box.patterns.fields()[1].seed.setValue(4711)
        })
        expect(rms(second, 0, SAMPLES_PER_BAR)).toBeGreaterThan(0.01)
        expect(second.some((value, index) => value !== first[index])).toBe(true)
    }, 300000)
    it("ignores a live control that is not automated", async () => {
        const first = await render(1, () => {})
        const edited = await render(1, box => box.live.seed.setValue(4711))
        expect(edited.every((value, index) => value === first[index])).toBe(true)
    }, 300000)
    it("follows the volume", async () => {
        const full = await render(1, () => {})
        const quiet = await render(1, box => box.volume.setValue(-15.0)) // 12 dB under the default of -3 dB
        const ratio = rms(quiet, 0, SAMPLES_PER_BAR) / rms(full, 0, SAMPLES_PER_BAR)
        expect(ratio).toBeGreaterThan(0.22)
        expect(ratio).toBeLessThan(0.28)
    }, 300000)
})
