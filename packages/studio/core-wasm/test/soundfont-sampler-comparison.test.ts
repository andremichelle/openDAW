// Does a Sampler loaded with a soundfont preset play like the Soundfont device? Renders the same notes through both
// in the real engine and reports the difference per note. Set OPENDAW_SOUNDFONT_DIR to a folder of .sf2 files.
import {describe, expect, it} from "vitest"
import {existsSync, readdirSync, readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {
    AudioFileBox, AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SamplerDeviceBox,
    SamplerModulationBox,
    SoundfontDeviceBox, SoundfontFileBox, TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, SamplerImport, SamplerModulation, SamplerSoundfont, SoundfontBank, TrackType} from "@opendaw/studio-adapters"
import {SoundBankLoader} from "spessasynth_core"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {simplifySoundfont} from "../src/soundfont-simplify"

const BEAT = 1920
const QUANTA_PER_BEAT = 375
const Notes = [{key: 36, velocity: 1.0}, {key: 48, velocity: 0.5}, {key: 60, velocity: 1.0}, {key: 72, velocity: 0.7},
    {key: 84, velocity: 1.0}]

type Scene = { source: BoxGraph, files: Map<string, SamplerImport.Sample> }

const scene = (populate: (source: BoxGraph, unit: AudioUnitBox) => Map<string, SamplerImport.Sample>): Scene => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const files = populate(source, unit)
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    Notes.forEach(({key, velocity}, index) => NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events); box.position.setValue(index * 2 * BEAT); box.duration.setValue(BEAT)
        box.pitch.setValue(key); box.velocity.setValue(velocity); box.cent.setValue(0)
    }))
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(64 * BEAT); box.loopDuration.setValue(64 * BEAT)
    })
    source.endTransaction()
    return {source, files}
}

const render = async ({source, files}: Scene, blob: ArrayBuffer): Promise<Float32Array> => {
    const {engine, memory, drainSoundfonts} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    const serve = () => {
        drainSoundfonts(() => blob)
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const uuid = UUID.toString(new Uint8Array(memory.buffer, requestPtr, 16).slice() as UUID.Bytes)
            const sample = files.get(uuid)!
            const frames = sample.channels[0].length, channels = sample.channels.length
            const pointer = engine.sample_allocate(handle, frames * channels * 4)
            const target = new Float32Array(memory.buffer, pointer, frames * channels)
            sample.channels.forEach((channel, index) => {
                for (let frame = 0; frame < frames; frame++) {target[index * frames + frame] = channel[frame] / 32768}
            })
            engine.sample_set_ready(handle, frames, channels, sample.sampleRate)
        }
    }
    await sync.settle(); engine.bind(); await sync.settle(); serve(); await sync.settle(); serve(); await sync.settle()
    engine.set_metronome_enabled(0)
    const length = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const quanta = Notes.length * 2 * QUANTA_PER_BEAT
    const out = new Float32Array(quanta * length)
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        out.set(new Float32Array(memory.buffer, engine.output_ptr(), length), quantum * length)
    }
    return out
}

const decibel = (value: number): string => value <= 0 ? "-inf" : (20 * Math.log10(value)).toFixed(1)

describe("Sampler vs Soundfont device", () => {
    const folder = process.env.OPENDAW_SOUNDFONT_DIR
    const files = folder !== undefined && existsSync(folder)
        ? readdirSync(folder).filter(name => name.toLowerCase().endsWith(".sf2")) : []
    it.skipIf(files.length === 0).each(files)("%s", async name => {
        const bytes = readFileSync(`${folder}/${name}`)
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const bank = SoundfontBank.from(SoundBankLoader.fromArrayBuffer(buffer), buffer)
        const blob = simplifySoundfont(bank)
        const device = await render(scene((source, unit) => {
            const file = SoundfontFileBox.create(source, UUID.generate(), box => box.fileName.setValue(name))
            SoundfontDeviceBox.create(source, UUID.generate(), box => {box.host.refer(unit.input); box.file.refer(file)})
            return new Map()
        }), blob)
        const {instrument, samples} = SamplerSoundfont.convert(bank, 0)
        const sampler = await render(scene((source, unit) => {
            const device = SamplerDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
            SamplerModulationBox.create(source, UUID.generate(), box => {
                box.device.refer(device.modulations); box.source.setValue(SamplerModulation.Source.Velocity)
                box.target.setValue(SamplerModulation.Target.Gain); box.amount.setValue(1.0)
            })
            const map = new Map<string, SamplerImport.Sample>()
            const audioFiles = samples.map(sample => {
                const file = AudioFileBox.create(source, UUID.generate(), box => {
                    box.fileName.setValue(sample.name); box.startInSeconds.setValue(0)
                    box.endInSeconds.setValue(sample.channels[0].length / sample.sampleRate)
                })
                map.set(UUID.toString(file.address.uuid), sample)
                return file
            })
            SamplerImport.apply(source, device, instrument, audioFiles)
            return map
        }), blob)
        const lines: Array<string> = []
        const perNote = device.length / Notes.length
        Notes.forEach(({key, velocity}, index) => {
            let energyDevice = 0, energySampler = 0, energyDifference = 0
            for (let at = index * perNote; at < (index + 1) * perNote; at++) {
                energyDevice += device[at] ** 2
                energySampler += sampler[at] ** 2
                energyDifference += (device[at] - sampler[at]) ** 2
            }
            const rms = (energy: number) => Math.sqrt(energy / perNote)
            lines.push(`key ${key} vel ${velocity}: device ${decibel(rms(energyDevice))} dB, sampler ${decibel(rms(energySampler))} dB, `
                + `difference ${decibel(rms(energyDifference))} dB (${decibel(Math.sqrt(energyDifference / Math.max(energyDevice, 1e-20)))} dB rel)`)
        })
        console.log(`${name} · ${bank.presets[0].header.name}\n  ${lines.join("\n  ")}`)
        expect(device.length).toBe(sampler.length)
    }, 300_000)
})
