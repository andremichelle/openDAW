// Cubed's own pattern through a groove in the FULL engine. One high note per bar with silence between, so each
// onset is countable: an offset groove moves every onset by the offset, a zero offset plays exactly as no groove.
// The oscillator runs freely, so a moved note starts at another phase and only its onset can be compared.
import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {AudioUnitBox, CubedDeviceBox, GrooveOffsetBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLES_PER_PULSE = 25 // 48k, 120 bpm, 960 per quarter
const BAR = 3840
const GATE = 1 << 7

const render = async (offset: int | null, bars: int): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const cubed = CubedDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.decay.setValue(0.0)
        box.cutoff.setValue(0.6)
    })
    const pattern = cubed.patterns.fields()[0]
    pattern.length.setValue(16)
    pattern.steps.fields()[0].setValue(72 | GATE)
    if (offset !== null) {
        const groove = GrooveOffsetBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.grooves)
            box.index.setValue(1)
            box.offset.setValue(offset)
        })
        cubed.groove.refer(groove)
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

// the first loud sample after a quiet stretch
const onsets = (samples: Float32Array): ReadonlyArray<int> => {
    const found: Array<int> = []
    let quiet = 2000
    samples.forEach((value, index) => {
        if (Math.abs(value) < 0.002) {quiet++; return}
        if (quiet >= 2000) {found.push(index)}
        quiet = 0
    })
    return found
}

describe("Cubed through a groove", () => {
    it("moves every note of its pattern by an offset", async () => {
        const straight = onsets(await render(null, 4))
        expect(straight.length).toBe(4)
        // a bar later than the last, for a negative offset that pulls it in
        const notes = [...straight, straight[3] + BAR * SAMPLES_PER_PULSE]
        for (const offset of [-240, 120, 240, 480]) {
            const grooved = await render(offset, 4)
            const expected = notes.map(sample => sample + offset * SAMPLES_PER_PULSE)
                .filter(sample => sample >= 0 && sample < grooved.length)
            const actual = onsets(grooved)
            expect(actual.length, `offset ${offset}: ${actual}`).toBe(expected.length)
            // the first note of a render attacks a little differently, the groove moves notes by thousands of samples
            actual.forEach((sample, index) =>
                expect(Math.abs(sample - expected[index]), `offset ${offset}: onset ${index}`).toBeLessThanOrEqual(40))
        }
    }, 300000)
    it("plays exactly as before with a zero offset", async () => {
        const straight = await render(null, 2)
        const zero = await render(0, 2)
        expect(zero.every((value, index) => value === straight[index])).toBe(true)
    }, 300000)
})
