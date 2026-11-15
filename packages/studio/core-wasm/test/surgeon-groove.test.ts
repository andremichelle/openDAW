// Surgeon's patterns through a groove in the FULL engine. The oscillators run freely, so a moved step starts at
// another phase: a moved render is compared by where it is quiet, a zero offset sample by sample.
import {describe, expect, it} from "vitest"
import {int, isDefined, Nullable, Procedure, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, GrooveOffsetBox, SurgeonDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLES_PER_PULSE = 25 // 48k, 120 bpm, 960 per quarter
const BAR = 3840

type Loop = { from: int, to: int }

const render = async (offset: Nullable<int>, bars: int, loop: Nullable<Loop> = null,
                      setup: Procedure<SurgeonDeviceBox> = () => {}, pattern: int = 0): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(isDefined(loop))
    if (isDefined(loop)) {
        timelineBox.loopArea.from.setValue(loop.from)
        timelineBox.loopArea.to.setValue(loop.to)
    }
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const surgeon = SurgeonDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        setup(box)
    })
    if (isDefined(offset)) {
        const groove = GrooveOffsetBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
            box.offset.setValue(offset)
        })
        surgeon.patterns.fields()[pattern].groove.refer(groove)
    }
    source.endTransaction()
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const half = (engine.output_len() >>> 0) >>> 1
    engine.stop(); engine.play()
    const quanta = Math.ceil(bars * BAR * SAMPLES_PER_PULSE / half)
    const left = new Float32Array(quanta * half)
    for (let index = 0; index < quanta; index++) {
        engine.render()
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), index * half)
    }
    sync.close()
    return left
}

const peak = (samples: Float32Array, from: int, to: int): number => {
    let max = 0.0
    for (let index = from; index < to; index++) {max = Math.max(max, Math.abs(samples[index]))}
    return max
}

describe("Surgeon through a groove", () => {
    it("plays exactly as without a groove with a zero offset", async () => {
        const straight = await render(null, 2)
        const zero = await render(0, 2)
        expect(zero.every((value, index) => value === straight[index])).toBe(true)
    }, 300000)
    it("plays exactly as without a groove when only a pattern that does not play has one", async () => {
        const straight = await render(null, 2)
        const other = await render(480, 2, null, () => {}, 3)
        expect(other.every((value, index) => value === straight[index])).toBe(true)
    }, 300000)
    it("starts later by a late offset and is silent until then", async () => {
        const straight = await render(null, 2)
        expect(peak(straight, 0, 2000)).toBeGreaterThan(0.01)
        for (const offset of [120, 240, 480]) {
            const grooved = await render(offset, 2)
            const start = offset * SAMPLES_PER_PULSE
            expect(peak(grooved, 0, start - 40), `offset ${offset}`).toBe(0.0)
            expect(peak(grooved, start, start + 2000), `offset ${offset}`).toBeGreaterThan(0.01)
        }
    }, 300000)
    it("plays the second step at once with an early offset", async () => {
        // every step starts a note, the second one is pulled to the start
        const everyStep: Procedure<SurgeonDeviceBox> = box => {
            box.live.density.setValue(1.0)
            box.live.tie.setValue(0.0)
        }
        const grooved = await render(-240, 2, null, everyStep)
        const straight = await render(null, 2, null, everyStep)
        expect(peak(grooved, 0, 2000)).toBeGreaterThan(0.01)
        expect(grooved.some((value, index) => value !== straight[index])).toBe(true)
        expect(grooved.every(Number.isFinite)).toBe(true)
    }, 300000)
    it("starts the first step late on every pass of a loop", async () => {
        // short notes on every step: after the wrap it stays quiet until the groove lets the first step start
        const shortNotes: Procedure<SurgeonDeviceBox> = box => {
            box.live.density.setValue(1.0)
            box.live.tie.setValue(0.0)
            box.live.held.setValue(0.0)
            box.live.lengthD.setValue(0.0)
        }
        const offset = 480
        const grooved = await render(offset, 5, {from: 0, to: BAR * 2}, shortNotes)
        for (const pass of [1, 2]) {
            const wrap = pass * BAR * 2 * SAMPLES_PER_PULSE
            const waiting = peak(grooved, wrap + 300 * SAMPLES_PER_PULSE, wrap + (offset - 10) * SAMPLES_PER_PULSE)
            const started = peak(grooved, wrap + offset * SAMPLES_PER_PULSE, wrap + (offset + 100) * SAMPLES_PER_PULSE)
            expect(started, `pass ${pass}`).toBeGreaterThan(0.01)
            expect(waiting, `pass ${pass}`).toBeLessThan(started * 0.05)
        }
    }, 300000)
    it("plays no step from behind the loop end with an early groove", async () => {
        // the last step of the loop is pulled a step early, then nothing starts until the wrap
        const shortNotes: Procedure<SurgeonDeviceBox> = box => {
            box.live.density.setValue(1.0)
            box.live.tie.setValue(0.0)
            box.live.held.setValue(0.0)
            box.live.lengthD.setValue(0.0)
        }
        const grooved = await render(-480, 3, {from: 0, to: BAR * 2}, shortNotes)
        const wrap = BAR * 2 * SAMPLES_PER_PULSE
        const lastStep = peak(grooved, wrap - 720 * SAMPLES_PER_PULSE, wrap - 620 * SAMPLES_PER_PULSE)
        const waiting = peak(grooved, wrap - 180 * SAMPLES_PER_PULSE, wrap - 10 * SAMPLES_PER_PULSE)
        expect(lastStep).toBeGreaterThan(0.01)
        expect(waiting).toBeLessThan(lastStep * 0.05)
    }, 300000)
    it("keeps playing through a loop with a groove", async () => {
        const grooved = await render(120, 6, {from: 0, to: BAR * 2})
        expect(grooved.every(Number.isFinite)).toBe(true)
        for (let bar = 0; bar < 6; bar++) {
            const from = bar * BAR * SAMPLES_PER_PULSE
            expect(peak(grooved, from, from + BAR * SAMPLES_PER_PULSE), `bar ${bar}`).toBeGreaterThan(0.01)
        }
    }, 300000)
})
