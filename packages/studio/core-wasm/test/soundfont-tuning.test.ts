// Issue 550: the Soundfont device ignored the tuning of a zone (coarse tune, fine tune, the sample's pitch
// correction), so a soundfont that tunes its samples that way played out of tune.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import type {SoundFont2} from "soundfont2"
import {AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SoundfontDeviceBox, SoundfontFileBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {encodeSoundfont, simplifySoundfont, SimpleRegion} from "../src/soundfont-simplify"

type Generators = Record<number, { value: number }>
const CoarseTune = 51, FineTune = 52, RootKey = 58

const soundfontOf = (instrument: Generators, preset: Generators = {}, pitchCorrection?: number): SoundFont2 => {
    const sample = {data: Int16Array.from([0, 100, 200, 300]), header: {sampleRate: 44100, startLoop: 0, endLoop: 4, originalPitch: 60, pitchCorrection}}
    return {samples: [sample], presets: [{zones: [{generators: preset, instrument: {zones: [{generators: instrument, sample}]}}]}]} as unknown as SoundFont2
}
const tuneOf = (soundfont: SoundFont2): number => {
    const view = new DataView(simplifySoundfont(soundfont))
    return view.getFloat32(view.getUint32(24, true) + 36, true)
}

describe("soundfont tuning: reading the generators", () => {
    it("a zone without tuning has none", () => expect(tuneOf(soundfontOf({[RootKey]: {value: 60}}))).toBe(0))
    it("fine tune is cents", () => expect(tuneOf(soundfontOf({[FineTune]: {value: -48}}))).toBe(-48))
    it("coarse tune is semitones", () => expect(tuneOf(soundfontOf({[CoarseTune]: {value: -2}}))).toBe(-200))
    it("the first zone of the reported piano: one semitone up, 50 cents down", () =>
        expect(tuneOf(soundfontOf({[RootKey]: {value: 51}, [CoarseTune]: {value: 1}, [FineTune]: {value: -50}}))).toBe(50))
    it("the preset's tuning adds to the instrument's", () =>
        expect(tuneOf(soundfontOf({[CoarseTune]: {value: 1}, [FineTune]: {value: 10}}, {[CoarseTune]: {value: 2}, [FineTune]: {value: 5}}))).toBe(315))
    it("the sample's pitch correction adds as well", () => {
        expect(tuneOf(soundfontOf({}, {}, -7))).toBe(-7)
        expect(tuneOf(soundfontOf({[FineTune]: {value: 35}}, {}, 5))).toBe(40)
    })
})

const FRAMES = 48_000
const ramp = (): Float32Array => Float32Array.from({length: FRAMES}, (_, index) => Math.sin(index * 0.01) * 0.5)
const region = (overrides: Partial<SimpleRegion>): SimpleRegion => ({
    keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, sampleIndex: 0, rootKey: 60, loopMode: 0, pan: 0.0,
    attack: 0.001, decay: 0.005, sustain: 1.0, release: 0.05, ...overrides
})
const render = async (overrides: Partial<SimpleRegion>): Promise<Float32Array> => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const file = SoundfontFileBox.create(source, UUID.generate(), box => box.fileName.setValue("test.sf2"))
    SoundfontDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.file.refer(file)
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
        box.duration.setValue(100_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    const {engine, memory, drainSoundfonts} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle()
    engine.bind()
    await sync.settle()
    drainSoundfonts(() => encodeSoundfont({
        samples: [{pcm: ramp(), sampleRate: 48_000, loopStart: 0, loopEnd: FRAMES}], presets: [[region(overrides)]]
    }))
    await sync.settle()
    engine.set_metronome_enabled(0)
    const length = engine.output_len() >>> 0
    engine.stop()
    engine.play()
    const output: Array<number> = []
    for (let quantum = 0; quantum < 100; quantum++) {
        engine.render()
        output.push(...new Float32Array(memory.buffer, engine.output_ptr(), length))
    }
    return Float32Array.from(output)
}
const bitsOf = (frames: Float32Array): Uint32Array => new Uint32Array(frames.buffer)

describe("soundfont tuning: playing", () => {
    it("a region without tune plays as one with a tune of zero", async () => {
        const plain = await render({})
        expect(plain.some(value => value !== 0.0)).toBe(true)
        expect(bitsOf(await render({tune: 0}))).toEqual(bitsOf(plain))
    }, 60_000)
    it("a hundred cents of tune play like a root key one lower", async () =>
        expect(bitsOf(await render({rootKey: 60, tune: 100}))).toEqual(bitsOf(await render({rootKey: 59}))), 60_000)
    it("the reported zone, one semitone up and 50 cents down, no longer plays like its bare root key", async () =>
        expect(bitsOf(await render({rootKey: 51, tune: 50}))).not.toEqual(bitsOf(await render({rootKey: 51}))), 60_000)
})
