// Wiring + behaviour: a Corrode audio-effect in a real unit's audio-fx chain receives the instrument and its
// parameters. A scriptable Apparat sine voices middle C. At Amount 0 the output stays a pure tone, in Sine mode at
// Amount 100 the delay modulation puts phase-modulation sidebands at the modulator frequency plus and minus the tone.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CorrodeDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: velocity * 0.8, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

const build = (mode: number, frequency: number, amount: number) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    let apparatUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + SYNTH)
    })
    apparatUuid = UUID.toString(apparat.address.uuid)
    CorrodeDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.mode.setValue(mode)
        box.frequency.setValue(frequency)
        box.amount.setValue(amount)
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
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.loopDuration.setValue(10_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, apparatUuid, 1, SYNTH))()
    return source
}

const render = async (source: ReturnType<typeof build>) => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    const half = len / 2
    const QUANTA = 32
    engine.stop(); engine.play()
    const left = new Float32Array(QUANTA * half)
    for (let q = 0; q < QUANTA; q++) {
        engine.render()
        const enginePtr = engine.output_ptr()
        left.set(new Float32Array(memory.buffer, enginePtr, half), q * half)
    }
    return left
}

const SAMPLE_RATE = 48000
const TONE = 440 * Math.pow(2, (60 - 69) / 12)

// Hann-windowed amplitude at one frequency.
const magnitude = (buffer: Float32Array, frequency: number): number => {
    let re = 0.0, im = 0.0, norm = 0.0
    buffer.forEach((sample, index) => {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (buffer.length - 1))
        const phase = 2 * Math.PI * frequency * index / SAMPLE_RATE
        re += sample * window * Math.cos(phase)
        im -= sample * window * Math.sin(phase)
        norm += window
    })
    return 2 * Math.hypot(re, im) / norm
}
const tail = (buffer: Float32Array) => buffer.subarray(buffer.length / 2)

describe("corrode device", () => {
    it("leaves the tone pure at amount 0", async () => {
        const clean = tail(await render(build(2, 5000, 0)))
        expect(clean.every(sample => Number.isFinite(sample))).toBe(true)
        expect(magnitude(clean, TONE)).toBeGreaterThan(0.5)
        expect(magnitude(clean, 5000 + TONE)).toBeLessThan(0.005)
    }, 30000)

    it("puts sidebands around the sine modulator at full amount", async () => {
        const eroded = tail(await render(build(2, 5000, 100)))
        expect(eroded.every(sample => Number.isFinite(sample))).toBe(true)
        expect(magnitude(eroded, 5000 + TONE)).toBeGreaterThan(0.1)
        expect(magnitude(eroded, 5000 - TONE)).toBeGreaterThan(0.1)
        expect(magnitude(eroded, TONE)).toBeLessThan(magnitude(tail(await render(build(2, 5000, 0))), TONE))
    }, 30000)
})
