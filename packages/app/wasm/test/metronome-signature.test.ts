// The metronome over the SIGNATURE TRACK + the metronome preferences/click-sound exports: accents follow
// the signature in effect (beat indices reset at a SignatureEventBox), the recording count-in offset uses
// the signature at the recording start, and uploaded click PCM (click_allocate/set_click_sound, the
// frozen-audio pattern) replaces the synthesized defaults. Preferences are driven at the export level
// (set_metronome_gain/-beat_sub_division/-monophonic) — the engine-preferences channel wiring lives in the
// studio worklet (processor.ts), which this harness does not instantiate.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {SignatureEventBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const BPM = 120.0
const SAMPLE_RATE = 48000.0

// An empty project (the metronome is the only sound source) with a 3/4 signature event after one 4/4 bar.
const build = (withSignatureEvent: boolean) => {
    const {boxGraph: source, mandatoryBoxes: {timelineBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    if (withSignatureEvent) {
        SignatureEventBox.create(source, UUID.generate(), box => {
            box.events.refer(timelineBox.signatureTrack.events)
            box.index.setValue(0)
            box.relativePosition.setValue(1)
            box.nominator.setValue(3)
            box.denominator.setValue(4)
        })
    }
    source.endTransaction()
    return {source, timelineBox}
}

// Two equal frames at the engine rate render exactly ONE output sample of `amplitude * gain`, so the
// output becomes a train of single-sample impulses whose value identifies the click kind.
const uploadImpulseClicks = (engine: any, memory: WebAssembly.Memory): void => {
    const upload = (index: 0 | 1, amplitude: number): void => {
        const pcm = engine.click_allocate(2, 1)
        new Float32Array(memory.buffer, pcm, 2).set([amplitude, amplitude])
        engine.set_click_sound(index, 2, 1, SAMPLE_RATE)
    }
    upload(0, 1.0)
    upload(1, 0.5)
}

const renderImpulses = (engine: any, memory: WebAssembly.Memory, quanta: number): Array<[number, number]> => {
    const len = engine.output_len() >>> 0
    const clicks: Array<[number, number]> = []
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        const output = new Float32Array(memory.buffer, engine.output_ptr(), len)
        const frames = len >> 1
        for (let index = 0; index < frames; index++) {
            if (output[index] !== 0.0) {clicks.push([quantum * frames + index, output[index]])}
        }
    }
    return clicks
}

const sampleOf = (pulse: number): number => PPQN.pulsesToSamples(pulse, BPM, SAMPLE_RATE)

const assertClickTrain = (clicks: Array<[number, number]>, expected: Array<[number, number]>): void => {
    expect(clicks.length, `click count of ${JSON.stringify(clicks)}`).toBe(expected.length)
    clicks.forEach(([sample, value], index) => {
        const [pulse, amplitude] = expected[index]
        expect(Math.abs(sample - sampleOf(pulse)), `click ${index} at sample ${sample}`).toBeLessThanOrEqual(1)
        expect(value, `click ${index} amplitude`).toBeCloseTo(amplitude, 5)
    })
}

describe("metronome + signature track", () => {
    it("accents reset at a signature event (4/4 -> 3/4 at bar 1) and uploaded clicks render", async () => {
        const {source} = build(true)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(1)
        engine.set_metronome_gain(0.0)
        uploadImpulseClicks(engine, memory)
        engine.play()
        const clicks = renderImpulses(engine, memory, Math.floor(sampleOf(8000) / 128))
        // downbeats at 0 (4/4) and 3840/6720 (3/4) — a static 4/4 would accent 7680 instead
        assertClickTrain(clicks, [[0, 1.0], [960, 0.5], [1920, 0.5], [2880, 0.5],
            [3840, 1.0], [4800, 0.5], [5760, 0.5], [6720, 1.0], [7680, 0.5]])
    }, 60000)

    it("beat sub-division and gain preferences shape the click train", async () => {
        const {source} = build(false)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(1)
        engine.set_metronome_gain(-12.0)
        engine.set_metronome_beat_sub_division(2)
        uploadImpulseClicks(engine, memory)
        engine.play()
        const clicks = renderImpulses(engine, memory, Math.floor(sampleOf(2000) / 128))
        const gain = Math.pow(10.0, -12.0 / 20.0)
        // eighths with the accent every `nominator` SUBDIVISIONS (the TS formula): 0 and 1920
        assertClickTrain(clicks, [[0, gain], [480, 0.5 * gain], [960, 0.5 * gain], [1440, 0.5 * gain], [1920, gain]])
    }, 60000)

    it("the count-in offset uses the signature at the recording start", async () => {
        const {source} = build(true)
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.set_position(3840) // recording starts where 3/4 is in effect
        engine.prepare_recording_state(1, 1.0)
        engine.render()
        const view = new DataView(memory.buffer, engine.engine_state_ptr(), engine.engine_state_len())
        const position = view.getFloat32(0)
        expect(view.getUint8(17), "counting in").toBe(1)
        // one 3/4 bar = 2880 pulses (a static 4/4 count-in would rewind to 0)
        expect(position).toBeGreaterThanOrEqual(960)
        expect(position).toBeLessThan(1000)
        const remaining = view.getFloat32(12)
        expect(remaining, "three quarter beats remain").toBeGreaterThan(2.9)
        expect(remaining).toBeLessThanOrEqual(3)
    }, 60000)
})
