// Renders a project through the real engine (core-wasm's harness) with device_mastering.wasm linked as an extra
// device on the output unit, against the same project without it. Needs both dist folders built.
import {describe, expect, it} from "vitest"
import {fileURLToPath} from "node:url"
import {UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox, AudioUnitBox, MasteringDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "../../core-wasm/test/helpers/load-full-engine"
import {connectSyncToEngine} from "../../core-wasm/test/helpers/connect-sync"

const SAMPLE_RATE = 48000
const LATENCY = 4096 / 2 + 48 + 16 * 48
const QUANTA = 200
const CURVE_BINS = 2049
const DEVICE = fileURLToPath(new URL("../dist/device_mastering.wasm", import.meta.url))

const CODE = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const t = voice.phase / sampleRate
                l[i] += 0.3 * Math.sin(2 * Math.PI * 1000 * t) + 0.1 * Math.sin(2 * Math.PI * 3100 * t)
                r[i] += 0.2 * Math.sin(2 * Math.PI * 1000 * t + 0.4)
                voice.phase++
            }
        }
    }
}`

type Mastering = {
    curve?: number, gain?: number, finalAmplitude?: number, limiter?: boolean, width?: number, amount?: number
}

const curveBytes = (value: number): Int8Array => {
    const values = new Float32Array(CURVE_BINS).fill(value)
    values[0] = 0.0
    return new Int8Array(values.buffer)
}

const render = async (mastering?: Mastering): Promise<[Float32Array, Float32Array]> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, primaryAudioUnitBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + CODE)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.duration.setValue(100_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    if (mastering !== undefined) {
        MasteringDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(primaryAudioUnitBox.audioEffects)
            box.limiter.setValue(mastering.limiter ?? false)
            box.matchGain.setValue(mastering.gain ?? 1.0)
            box.finalAmplitude.setValue(mastering.finalAmplitude ?? 1.0)
            box.width.setValue(mastering.width ?? 1.0)
            box.amount.setValue(mastering.amount ?? 1.0)
            if (mastering.curve !== undefined) {
                box.midCurve.setValue(curveBytes(mastering.curve))
                box.sideCurve.setValue(curveBytes(mastering.curve))
            }
        })
    }
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, CODE))()
    const {engine, memory} = await loadFullEngine(SAMPLE_RATE, undefined, undefined, undefined,
        [{file: DEVICE, boxType: "MasteringDeviceBox"}])
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const length = engine.output_len() >>> 0
    const half = length / 2
    engine.stop(); engine.play()
    const left = new Float32Array(QUANTA * half)
    const right = new Float32Array(QUANTA * half)
    for (let quantum = 0; quantum < QUANTA; quantum++) {
        engine.render()
        const output = new Float32Array(memory.buffer, engine.output_ptr(), length)
        left.set(output.subarray(0, half), quantum * half)
        right.set(output.subarray(half), quantum * half)
    }
    return [left, right]
}

const STEADY = 8192

const deviation = (actual: Float32Array, reference: Float32Array, scale: number, shift: number): number => {
    let worst = 0.0
    for (let index = STEADY; index < actual.length; index++) {
        worst = Math.max(worst, Math.abs(actual[index] - scale * reference[index - shift]))
    }
    return worst
}

const peak = (values: Float32Array): number =>
    values.subarray(STEADY).reduce((max, value) => Math.max(max, Math.abs(value)), 0.0)

describe("device_mastering.wasm in the engine", async () => {
    const [referenceLeft, referenceRight] = await render()
    it("without an analysis it only delays and applies the match gain", async () => {
        expect(peak(referenceLeft)).toBeGreaterThan(0.3)
        expect(peak(referenceRight)).toBeGreaterThan(0.15)
        const [left, right] = await render({gain: 0.5})
        expect(deviation(left, referenceLeft, 0.5, LATENCY - 1)).toBeGreaterThan(1e-2)
        expect(deviation(left, referenceLeft, 0.5, LATENCY)).toBeLessThan(1e-6)
        expect(deviation(right, referenceRight, 0.5, LATENCY)).toBeLessThan(1e-6)
    }, 60000)
    it("a flat curve keeps the signal, a doubled curve doubles it", async () => {
        const [flat] = await render({curve: 1.0})
        expect(deviation(flat, referenceLeft, 1.0, LATENCY)).toBeLessThan(2e-3)
        const [doubled] = await render({curve: 2.0})
        expect(deviation(doubled, referenceLeft, 2.0, LATENCY)).toBeLessThan(4e-3)
    }, 60000)
    it("amount zero bypasses the curve", async () => {
        const [left] = await render({curve: 2.0, amount: 0.0})
        expect(deviation(left, referenceLeft, 1.0, LATENCY)).toBeLessThan(1e-6)
    }, 60000)
    it("width zero folds to mono", async () => {
        const [left, right] = await render({curve: 1.0, width: 0.0})
        expect(deviation(left, right, 1.0, 0)).toBeLessThan(1e-6)
    }, 60000)
    it("the limiter holds the ceiling and the final amplitude scales after it", async () => {
        const [limited] = await render({curve: 1.0, gain: 4.0, limiter: true})
        expect(peak(limited)).toBeLessThanOrEqual(0.9982)
        expect(peak(limited)).toBeGreaterThan(0.9)
        const [scaled] = await render({curve: 1.0, gain: 4.0, limiter: true, finalAmplitude: 0.5})
        expect(deviation(scaled, limited, 0.5, 0)).toBeLessThan(1e-6)
    }, 60000)
})
