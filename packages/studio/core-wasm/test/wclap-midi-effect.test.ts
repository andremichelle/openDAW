// A WebCLAP note effect in the real engine: a note track, Note Lab (test/assets/note-lab.wasm, open-webclap
// ports/note-lab) as the unit's MIDI effect, a MIDI Output as the instrument. The plugin's mode comes from its
// saved state (preset A Thru, B Harmony, C Echo 250 ms x 3), so no parameter boxes are needed.
import {describe, expect, it} from "vitest"
import * as path from "node:path"
import {readFileSync} from "node:fs"
import {UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {
    AudioUnitBox,
    CaptureMidiBox,
    DelayDeviceBox,
    InstrumentCompositeBox,
    InstrumentCompositeCellBox,
    MIDIOutputBox,
    MIDIOutputDeviceBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    PitchDeviceBox,
    TrackBox,
    WclapMidiEffectBox
} from "@opendaw/studio-boxes"
import {InstrumentFactories, ProjectSkeleton, TrackType, WclapStatus} from "@opendaw/studio-adapters"
import type {WclapBundle} from "../src/wclap/wclap-bridge"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLE_RATE = 48000
const BPM = 120.0
const QUANTUM_MS = 128 / SAMPLE_RATE * 1000
const SAMPLE_MS = 1000 / SAMPLE_RATE
const RECORD_BYTES = 16
const NOTE_LAB = path.resolve(__dirname, "assets", "note-lab.wasm")
const bundle: WclapBundle = {files: [{path: "module.wasm", bytes: new Uint8Array(readFileSync(NOTE_LAB))}]}

enum Preset {Thru = 0, Harmony = 1, Echo = 2}

// Note Lab's 72-byte state: "NLAB", version, preset, reserved, then its eight default presets
const stateOf = (preset: Preset): Int8Array => {
    const slots: ReadonlyArray<[number, number, number, number]> = [
        [0, 3, 0, 250], [1, 3, 0, 250], [2, 3, 0, 250], [3, 3, 0, 250], [1, 3, 12, 250], [2, 6, 0, 125], [1, 3, -12, 250], [2, 2, 7, 500]]
    const view = new DataView(new ArrayBuffer(72))
    ;[0x4e, 0x4c, 0x41, 0x42, 1, preset].forEach((byte, index) => view.setUint8(index, byte))
    slots.forEach(([mode, repeats, transpose, delay], index) => {
        view.setUint8(8 + index * 8, mode)
        view.setUint8(9 + index * 8, repeats)
        view.setInt8(10 + index * 8, transpose)
        view.setFloat32(12 + index * 8, delay, true)
    })
    return new Int8Array(view.buffer)
}

type Note = { on: boolean, pitch: number, channel: number, velocity: number, ms: number }

type Options = { instrument?: "midi-output" | "vaporisateur", effect?: "wclap" | "pitch" }

const build = (preset: Preset, layers: number, notes: ReadonlyArray<[number, number, number]>, options: Options = {}) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const output = () => MIDIOutputBox.create(source, UUID.generate(), box => {
        box.root.refer(rootBox.outputMidiDevices)
        box.id.setValue("test-midi-device")
        box.label.setValue("Test Device")
        box.delayInMs.setValue(0)
    })
    const device = options.instrument === "vaporisateur" ? null : output()
    const outputOn = (host: AudioUnitBox["input"] | InstrumentCompositeCellBox["instrument"], channel: number) =>
        MIDIOutputDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(host)
            box.channel.setValue(channel)
            if (device !== null) {box.device.refer(device.device)}
        })
    if (options.instrument === "vaporisateur") {
        InstrumentFactories.Vaporisateur.create(source, unit.input, "Vaporisateur", InstrumentFactories.Vaporisateur.defaultIcon)
    } else if (layers === 0) {
        outputOn(unit.input, 0)
    } else {
        const composite = InstrumentCompositeBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        for (let index = 0; index < layers; index++) {
            const cell = InstrumentCompositeCellBox.create(source, UUID.generate(), cell => {
                cell.composite.refer(composite.cells)
                cell.index.setValue(index)
            })
            outputOn(cell.instrument, index)
        }
    }
    const effect: WclapMidiEffectBox | PitchDeviceBox = options.effect === "pitch"
        ? PitchDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(0)
            box.octaves.setValue(1)
        })
        : WclapMidiEffectBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(0)
            box.url.setValue("test:note-lab")
            box.clapId.setValue("studio.opendaw.note-lab")
            box.pluginState.setValue(stateOf(preset))
        })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    for (const [position, duration, pitch] of notes) {
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events)
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.pitch.setValue(pitch)
            box.velocity.setValue(1.0)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(3840 * 8)
        box.loopDuration.setValue(3840 * 8)
    })
    source.endTransaction()
    return {source, effect, unit}
}

const drainNotes = (engine: any, memory: WebAssembly.Memory, quantum: number): Array<Note> => {
    const count = engine.midi_out_count() >>> 0
    if (count === 0) {return []}
    const pointer = engine.input_reserve(count * RECORD_BYTES)
    const taken = engine.midi_out_take(pointer) >>> 0
    const view = new DataView(memory.buffer, pointer, taken * RECORD_BYTES)
    const notes: Array<Note> = []
    for (let index = 0; index < taken; index++) {
        const status = view.getUint8(index * RECORD_BYTES + 4)
        if ((status & 0xe0) !== 0x80) {continue}
        notes.push({on: (status & 0xf0) === 0x90, channel: status & 0x0f, pitch: view.getUint8(index * RECORD_BYTES + 5),
            velocity: view.getUint8(index * RECORD_BYTES + 6), ms: quantum * QUANTUM_MS + view.getFloat64(index * RECORD_BYTES + 8, true)})
    }
    return notes
}

// Loads the engine with Note Lab, waits until the plugin is up, plays `quanta` and returns every note sent out
const play = async (preset: Preset, layers: number, notes: ReadonlyArray<[number, number, number]>, quanta: number) => {
    const {source} = build(preset, layers, notes)
    const statuses: Array<WclapStatus> = []
    const ready = {resolve: () => {}}
    const up = new Promise<void>(resolve => {ready.resolve = resolve})
    const {engine, memory} = await loadFullEngine(SAMPLE_RATE, () => {}, () => null, {
        loadBundle: () => Promise.resolve(bundle),
        sendStatus: (_uuid, status) => {
            statuses.push(status)
            if (status.state === "ready") {ready.resolve()}
        }
    })
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    engine.render()
    await up
    drainNotes(engine, memory, 0)
    engine.play()
    const sent: Array<Note> = []
    for (let quantum = 0; quantum < quanta; quantum++) {
        engine.render()
        sent.push(...drainNotes(engine, memory, quantum))
    }
    return {sent, statuses}
}

const msOf = (pulses: number): number => PPQN.pulsesToSeconds(pulses, BPM) * 1000
const brief = (notes: ReadonlyArray<Note>) => notes.map(({on, pitch, channel}) => `${on ? "+" : "-"}${pitch}/${channel}`)

describe("WebCLAP note effect (wasm engine)", () => {
    it("passes notes on at their sample in Thru", async () => {
        const {sent} = await play(Preset.Thru, 0, [[0, 960, 60], [480, 480, 64]], 200)
        expect(brief(sent)).toEqual(["+60/0", "+64/0", "-60/0", "-64/0"])
        const expected = [0, 480, 960, 960].map(msOf)
        sent.forEach((note, index) => expect(Math.abs(note.ms - expected[index])).toBeLessThan(SAMPLE_MS))
    }, 60000)

    it("adds the third and the fifth at the same sample in Harmony", async () => {
        const {sent} = await play(Preset.Harmony, 0, [[960, 960, 60]], 500)
        expect(brief(sent)).toEqual(["+60/0", "+64/0", "+67/0", "-60/0", "-64/0", "-67/0"])
        sent.slice(0, 3).forEach(note => expect(Math.abs(note.ms - msOf(960))).toBeLessThan(SAMPLE_MS))
        sent.slice(3).forEach(note => expect(Math.abs(note.ms - msOf(1920))).toBeLessThan(SAMPLE_MS))
    }, 60000)

    it("repeats at the plugin's delay, sample exact across quanta, in Echo", async () => {
        const {sent} = await play(Preset.Echo, 0, [[0, 240, 60]], 600)
        const ons = sent.filter(note => note.on)
        expect(ons.map(note => note.velocity)).toEqual([127, 95, 64, 32])
        ons.forEach((note, repeat) => expect(Math.abs(note.ms - repeat * 250)).toBeLessThan(SAMPLE_MS))
        sent.filter(note => !note.on).forEach((note, repeat) => expect(Math.abs(note.ms - (msOf(240) + repeat * 250))).toBeLessThan(SAMPLE_MS))
    }, 60000)

    it("gives every composite layer the same notes and runs the plugin once per span", async () => {
        const {sent} = await play(Preset.Echo, 2, [[0, 240, 60]], 600)
        for (const channel of [0, 1]) {
            const ons = sent.filter(note => note.on && note.channel === channel)
            expect(ons.length).toBe(4)
            ons.forEach((note, repeat) => expect(Math.abs(note.ms - repeat * 250)).toBeLessThan(SAMPLE_MS))
        }
    }, 60000)
})

// A MIDI effect that leaves the chain while its note sounds: the instrument after it (here a MIDI Output) ends
// the notes it got through the old chain, a rewire that keeps the chain keeps them
describe("WebCLAP note effect, held notes", () => {
    type Run = { notes: ReadonlyArray<string>, peakAfter: number }
    const holdThenChange = async (change: (built: ReturnType<typeof build>) => void, layers: number = 0,
                                  options: Options = {}): Promise<Run> => {
        const built = build(Preset.Thru, layers, [[0, 3840 * 4, 60]], options)
        const ready = {resolve: () => {}}
        const up = new Promise<void>(resolve => {ready.resolve = resolve})
        const {engine, memory} = await loadFullEngine(SAMPLE_RATE, () => {}, () => null, {
            loadBundle: () => Promise.resolve(bundle),
            sendStatus: (_uuid, status) => {if (status.state === "ready") {ready.resolve()}}
        })
        const sync = connectSyncToEngine(engine, memory, built.source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.render()
        if (options.effect !== "pitch") {await up}
        drainNotes(engine, memory, 0)
        engine.play()
        const sent: Array<Note> = []
        for (let quantum = 0; quantum < 100; quantum++) {
            engine.render()
            sent.push(...drainNotes(engine, memory, quantum))
        }
        built.source.beginTransaction()
        change(built)
        built.source.endTransaction()
        await sync.settle()
        let peakAfter = 0
        for (let quantum = 100; quantum < 300; quantum++) {
            engine.render()
            sent.push(...drainNotes(engine, memory, quantum))
            if (quantum >= 200) {
                const output = new Float32Array(memory.buffer, engine.output_ptr(), 256)
                peakAfter = output.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), peakAfter)
            }
        }
        return {notes: brief(sent), peakAfter}
    }

    it("ends the note it holds when it is bypassed", async () => {
        expect((await holdThenChange(({effect}) => effect.enabled.setValue(false))).notes).toEqual(["+60/0", "-60/0"])
    }, 60000)

    it("ends the note it holds when it is removed", async () => {
        expect((await holdThenChange(({effect}) => effect.delete())).notes).toEqual(["+60/0", "-60/0"])
    }, 60000)

    it("keeps the note when a rewire leaves the MIDI effects as they are", async () => {
        expect((await holdThenChange(({source, unit}) => DelayDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        }))).notes).toEqual(["+60/0"])
    }, 60000)

    it("ends a stock MIDI effect's note too (Pitch, an octave up)", async () => {
        expect((await holdThenChange(({effect}) => effect.enabled.setValue(false), 0, {effect: "pitch"})).notes)
            .toEqual(["+72/0", "-72/0"])
    }, 60000)

    it("ends it in a composite layer, whose MIDI Output survives the edit", async () => {
        expect((await holdThenChange(({effect}) => effect.enabled.setValue(false), 1)).notes).toEqual(["+60/0", "-60/0"])
    }, 60000)

    it("silences a plugin instrument's voice of it", async () => {
        const {peakAfter} = await holdThenChange(({effect}) => effect.enabled.setValue(false), 0, {instrument: "vaporisateur"})
        expect(peakAfter).toBe(0)
    }, 60000)

    it("keeps a plugin instrument's voice when a rewire leaves the MIDI effects as they are", async () => {
        const {peakAfter} = await holdThenChange(({source, unit}) => DelayDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
        }), 0, {instrument: "vaporisateur"})
        expect(peakAfter).toBeGreaterThan(0.01)
    }, 60000)
})
