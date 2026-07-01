// Wiring + behaviour: a Crusher audio-effect in a real unit's audio-fx chain must receive the instrument, its
// parameters, and quantise the signal. A scriptable Apparat sine (~0.8 peak) voices a note; the Crusher runs at
// 1 bit / near-nyquist S&H, so the wet output collapses to a handful of discrete levels ({-1, 0, 1}) — which only
// happens if the device is wired and its crush/bits/mix params applied. A mix=0 render proves the dry path (the
// smooth sine, many distinct values) differs.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, CrusherDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
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

const build = (crush: number, bits: number, mix: number) => {
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
    CrusherDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.crush.setValue(crush) // 0 = clean (near-nyquist S&H), 1 = maximally crushed
        box.bits.setValue(bits)
        box.boost.setValue(0.0)
        box.mix.setValue(mix)
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
        left.set(new Float32Array(memory.buffer, engine.output_ptr(), half), q * half)
    }
    return left
}

// Distinct output levels, rounded to 1e-3 (a smooth signal has many; a bit-crushed one has few).
const distinctLevels = (buffer: Float32Array) => new Set(Array.from(buffer, sample => Math.round(sample * 1000))).size
const peakOf = (buffer: Float32Array) => buffer.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)

describe("crusher device", () => {
    it("quantises the instrument to few discrete levels at 1 bit, full wet", async () => {
        const wet = await render(build(0.0, 1, 1.0))
        expect(wet.every(sample => Number.isFinite(sample))).toBe(true)
        expect(peakOf(wet)).toBeGreaterThan(0.5)     // it sounds
        expect(distinctLevels(wet)).toBeLessThan(12) // collapsed to ~{-1, 0, 1} (heavy bit-crush)
    }, 30000)

    it("passes the smooth instrument through when mix is 0", async () => {
        const dry = await render(build(0.0, 1, 0.0))
        expect(dry.every(sample => Number.isFinite(sample))).toBe(true)
        expect(peakOf(dry)).toBeGreaterThan(0.5)
        expect(distinctLevels(dry)).toBeGreaterThan(100) // a smooth sine has many distinct levels
    }, 30000)
})
