// The MIDI-OUTPUT instrument end-to-end (TS MIDIOutputDeviceProcessor + MIDITransportClock, engine-side):
// a unit whose instrument is a MIDIOutputDeviceBox must build (not tear down), emit byte-exact note-on /
// note-off records with the TS timing formula ((s0/sampleRate + pulsesToSeconds(position - p0, bpm)) * 1000
// + delayInMs), light the unit's 128-bit note indicator while the note is held, emit the initial CC push,
// and — with sendTransportMessages — Start/Stop plus 24-ppq Clock ticks.
import {describe, expect, it} from "vitest"
import {asDefined, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {
    AudioUnitBox,
    CaptureMidiBox,
    InstrumentCompositeBox,
    InstrumentCompositeCellBox,
    MIDIOutputBox,
    MIDIOutputDeviceBox,
    MIDIOutputParameterBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SAMPLE_RATE = 48000
const BPM = 120.0
const DELAY_MS = 10
const CHANNEL = 2
const RECORD_BYTES = 16
const PACKAGE_INT_ARRAY = 3

type MidiRecord = {device: number, status: number, data1: number, data2: number, length: number, timeMs: number}

const build = (options: {sendTransport: boolean, withNote: boolean, withParameter: boolean, layered?: boolean,
    muted?: boolean, soloOther?: boolean, nested?: boolean}) => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const outputBox = MIDIOutputBox.create(source, UUID.generate(), box => {
        box.root.refer(rootBox.outputMidiDevices)
        box.id.setValue("test-midi-device")
        box.label.setValue("Test Device")
        box.delayInMs.setValue(DELAY_MS)
        box.sendTransportMessages.setValue(options.sendTransport)
    })
    // the outer layer carries mute / solo, a nested composite inside it hosts the device when asked
    const layer = () => {
        const composite = InstrumentCompositeBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        if (options.soloOther === true) {
            InstrumentCompositeCellBox.create(source, UUID.generate(), cell => {
                cell.composite.refer(composite.cells)
                cell.index.setValue(1)
                cell.solo.setValue(true)
            })
        }
        const outer = InstrumentCompositeCellBox.create(source, UUID.generate(), cell => {
            cell.composite.refer(composite.cells)
            cell.index.setValue(0)
            cell.mute.setValue(options.muted === true)
        })
        if (options.nested !== true) {return {outer, leaf: outer}}
        const inner = InstrumentCompositeBox.create(source, UUID.generate(), box => box.host.refer(outer.instrument))
        const leaf = InstrumentCompositeCellBox.create(source, UUID.generate(), cell => {
            cell.composite.refer(inner.cells)
            cell.index.setValue(0)
        })
        return {outer, leaf}
    }
    const layers = options.layered === true ? layer() : undefined
    const cell = layers?.outer
    const host = layers?.leaf.instrument ?? unit.input
    const device = MIDIOutputDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(host)
        box.channel.setValue(CHANNEL)
        box.device.refer(outputBox.device)
    })
    if (options.withParameter) {
        // The studio's AddParameterButton always pairs the parameter with a Value track targeting its
        // `value` field (the mandatory pointer edge, the CC automation lane).
        const parameter = MIDIOutputParameterBox.create(source, UUID.generate(), box => {
            box.owner.refer(device.parameters)
            box.controller.setValue(74)
            box.value.setValue(0.25)
        })
        TrackBox.create(source, UUID.generate(), box => {
            box.index.setValue(1)
            box.target.refer(parameter.value)
            box.type.setValue(TrackType.Value)
            box.tracks.refer(unit.tracks)
        })
    }
    if (options.withNote) {
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
            box.duration.setValue(960)
            box.pitch.setValue(60)
            box.velocity.setValue(1.0)
            box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(3840 * 4)
            box.loopDuration.setValue(3840)
        })
    }
    source.endTransaction()
    return {source, unit, unitUuid: unit.address.uuid, device, cell}
}

const drainMIDI = (engine: any, memory: WebAssembly.Memory): Array<MidiRecord> => {
    const count = engine.midi_out_count() >>> 0
    if (count === 0) {return []}
    const pointer = engine.input_reserve(count * RECORD_BYTES)
    const taken = engine.midi_out_take(pointer) >>> 0
    const view = new DataView(memory.buffer, pointer, taken * RECORD_BYTES)
    const records: Array<MidiRecord> = []
    for (let index = 0; index < taken; index++) {
        const offset = index * RECORD_BYTES
        records.push({
            device: view.getUint32(offset, true),
            status: view.getUint8(offset + 4),
            data1: view.getUint8(offset + 5),
            data2: view.getUint8(offset + 6),
            length: view.getUint8(offset + 7),
            timeMs: view.getFloat64(offset + 8, true)
        })
    }
    return records
}

const readDeviceId = (engine: any, memory: WebAssembly.Memory, num: number): string => {
    const pointer = engine.input_reserve(256)
    const length = engine.midi_out_device_id(num, pointer, 256) >>> 0
    return length === 0 ? "" : new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length).slice())
}

const noteBitsEntry = (engine: any, memory: WebAssembly.Memory, unitUuid: Uint8Array): Int32Array => {
    const count = engine.broadcast_count() >>> 0
    for (let index = 0; index < count; index++) {
        const recordPtr = engine.input_reserve(48)
        if (engine.broadcast_entry(index, recordPtr) === 0) {continue}
        const record = new DataView(memory.buffer, recordPtr, 48)
        const uuid = new Uint8Array(memory.buffer, recordPtr, 16).slice()
        if (!UUID.equals(uuid as UUID.Bytes, unitUuid as UUID.Bytes)) {continue}
        if (record.getUint32(16, true) !== PACKAGE_INT_ARRAY) {continue}
        return new Int32Array(memory.buffer, record.getUint32(20, true), record.getUint32(24, true))
    }
    return asDefined(undefined, "the unit's note-bits broadcast entry is registered")
}

const anyBit = (bits: Int32Array): number => bits[0] | bits[1] | bits[2] | bits[3]

// Mirror the transport's per-quantum pulse advance (f64, identical op order to Rust samples_to_pulses).
const pulsesPerQuantum = PPQN.secondsToPulses(128 / SAMPLE_RATE, BPM)

describe("MIDI output instrument (wasm engine)", () => {
    it.each([false, true])("emits byte-exact note records with TS timing and lights the note indicator (layered: %s)", async layered => {
        const {source, unitUuid} = build({sendTransport: false, withNote: true, withParameter: true, layered})
        const {engine, memory} = await loadFullEngine(SAMPLE_RATE)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        // The build's initial CC push (TS constructor readAllParameters): controller 74,
        // Math.round(0.25 * 127) = 32, at 0 ms — before any transport movement.
        const initial = drainMIDI(engine, memory)
        expect(initial).toEqual([{device: 0, status: 0xB0 | CHANNEL, data1: 74, data2: 32, length: 3, timeMs: 0.0}])
        expect(readDeviceId(engine, memory, 0)).toBe("test-midi-device")
        const bits = noteBitsEntry(engine, memory, unitUuid)
        expect(anyBit(bits)).toBe(0)
        engine.play()
        const records: Array<MidiRecord> = []
        const positions: Array<number> = [] // p0 per rendered quantum, mirroring the transport accumulation
        const bitWhileHeld: Array<number> = []
        for (let quantum = 0, p0 = 0.0; quantum < 200; quantum++, p0 += pulsesPerQuantum) {
            positions.push(p0)
            engine.render()
            records.push(...drainMIDI(engine, memory))
            if (quantum === 100) {bitWhileHeld.push(anyBit(bits))} // note (0..960 pulses) still held here
        }
        expect(records.length).toBe(2)
        const [noteOn, noteOff] = records
        // Note-on: 0x90|channel, pitch 60, Math.round(1.0 * 127) = 127; the note sits exactly at p0 = 0 of
        // the first block, so time = (0 / sampleRate + pulsesToSeconds(0, bpm)) * 1000 + delay = 10 ms.
        expect(noteOn).toEqual({device: 0, status: 0x90 | CHANNEL, data1: 60, data2: 127, length: 3, timeMs: DELAY_MS})
        // Note-off at pulse 960: find its quantum and apply the exact TS formula.
        const offP0 = asDefined(positions.find((p0) => p0 <= 960 && 960 < p0 + pulsesPerQuantum), "note-off quantum")
        const expectedOffMs = (0 / SAMPLE_RATE + PPQN.pulsesToSeconds(960 - offP0, BPM)) * 1000.0 + DELAY_MS
        expect(noteOff.status).toBe(0x80 | CHANNEL)
        expect(noteOff.data1).toBe(60)
        expect(noteOff.data2).toBe(0)
        expect(noteOff.timeMs).toBe(expectedOffMs)
        expect(bitWhileHeld[0] !== 0, "note bit set while the note is held").toBe(true)
        expect((bits[1] >>> (60 - 32)) & 1, "bit 60 in particular").toBe(0) // released by now (note ended at 960)
        engine.stop()
        expect(anyBit(bits), "stop clears the note bits").toBe(0)
    }, 60000)

    it("sends Start, 24-ppq Clock ticks and Stop when sendTransportMessages is on", async () => {
        const {source} = build({sendTransport: true, withNote: false, withParameter: false})
        const {engine, memory} = await loadFullEngine(SAMPLE_RATE)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        drainMIDI(engine, memory)
        engine.play()
        const records: Array<MidiRecord> = []
        const positions: Array<number> = []
        for (let quantum = 0, p0 = 0.0; quantum < 16; quantum++, p0 += pulsesPerQuantum) {
            positions.push(p0)
            engine.render()
            records.push(...drainMIDI(engine, memory))
        }
        // Start (scheduled by play) arrives first, timestamped with the box delay only.
        expect(records[0]).toEqual({device: 0, status: 0xFA, data1: 0, data2: 0, length: 1, timeMs: DELAY_MS})
        // Clock ticks every 40 pulses (PPQN.fromSignature(1, 96)): 16 quanta cover 81.92 pulses -> 0, 40, 80.
        const clocks = records.filter(record => record.status === 0xF8)
        expect(clocks.length).toBe(3)
        clocks.forEach((clock, index) => {
            const tick = index * 40
            const p0 = asDefined(positions.find(start => start <= tick && tick < start + pulsesPerQuantum), "tick quantum")
            const expected = (0 / SAMPLE_RATE + PPQN.pulsesToSeconds(tick - p0, BPM)) * 1000.0 + DELAY_MS
            expect(clock.length).toBe(1)
            expect(clock.timeMs).toBe(expected)
        })
        expect(records.length).toBe(4, "Start + three clocks, nothing else")
        engine.pause()
        engine.render()
        const afterPause = drainMIDI(engine, memory)
        expect(afterPause).toEqual([{device: 0, status: 0xFC, data1: 0, data2: 0, length: 1, timeMs: DELAY_MS}])
        engine.set_position(3840.0)
        engine.render()
        const afterSeek = drainMIDI(engine, memory)
        // SongPosition: Math.floor(3840 / 96) = 40 -> lsb 40, msb 0 (the mirrored TS constant).
        expect(afterSeek).toEqual([{device: 0, status: 0xF2, data1: 40, data2: 0, length: 3, timeMs: DELAY_MS}])
    }, 60000)

    it.each([false, true])("binds a CC parameter added later and goes quiet once removed (layered: %s)", async layered => {
        const {source, unit, device} = build({sendTransport: false, withNote: false, withParameter: false, layered})
        const {engine, memory} = await loadFullEngine(SAMPLE_RATE)
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        expect(drainMIDI(engine, memory), "no parameters, no initial push").toEqual([])
        source.beginTransaction()
        const parameter = MIDIOutputParameterBox.create(source, UUID.generate(), box => {
            box.owner.refer(device.parameters)
            box.controller.setValue(7)
            box.value.setValue(0.5)
        })
        TrackBox.create(source, UUID.generate(), box => {
            box.index.setValue(0)
            box.target.refer(parameter.value)
            box.type.setValue(TrackType.Value)
            box.tracks.refer(unit.tracks)
        })
        source.endTransaction()
        await sync.settle()
        engine.play()
        for (let quantum = 0; quantum < 4; quantum++) {engine.render()}
        expect(drainMIDI(engine, memory), "a joining parameter stays silent").toEqual([])
        source.beginTransaction()
        parameter.value.setValue(1.0)
        source.endTransaction()
        await sync.settle()
        for (let quantum = 0; quantum < 4; quantum++) {engine.render()}
        const changed = drainMIDI(engine, memory)
        expect(changed.map(({status, data1, data2}) => ({status, data1, data2})))
            .toEqual([{status: 0xB0 | CHANNEL, data1: 7, data2: 127}])
        source.beginTransaction()
        unit.tracks.pointerHub.incoming().forEach(({box}) => box.delete())
        device.delete()
        source.endTransaction()
        await sync.settle()
        for (let quantum = 0; quantum < 4; quantum++) {engine.render()}
        expect(drainMIDI(engine, memory)).toEqual([])
    }, 60000)

    const playNotes = async (options: {muted?: boolean, soloOther?: boolean, nested?: boolean}) => {
        const scene = build({sendTransport: false, withNote: true, withParameter: false, layered: true, ...options})
        const {engine, memory} = await loadFullEngine(SAMPLE_RATE)
        const sync = connectSyncToEngine(engine, memory, scene.source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.play()
        return {...scene, engine, memory, sync}
    }

    it.each([{muted: true}, {soloOther: true}, {muted: true, nested: true}, {soloOther: true, nested: true}])(
        "a layer that is silent (%o) sends no new notes", async options => {
        const {engine, memory} = await playNotes(options)
        const records: Array<MidiRecord> = []
        for (let quantum = 0; quantum < 200; quantum++) {
            engine.render()
            records.push(...drainMIDI(engine, memory))
        }
        expect(records).toEqual([])
    }, 60000)

    it.each([false, true])("muting a layer while its note is held still releases that note, unmuting lets the next one through (nested: %s)", async nested => {
        const {engine, memory, sync, source, cell} = await playNotes({nested})
        const records: Array<MidiRecord> = []
        const render = (quanta: number) => {
            for (let quantum = 0; quantum < quanta; quantum++) {
                engine.render()
                records.push(...drainMIDI(engine, memory))
            }
        }
        render(10)
        expect(records.map(record => record.status), "the note started").toEqual([0x90 | CHANNEL])
        source.beginTransaction()
        asDefined(cell).mute.setValue(true)
        source.endTransaction()
        await sync.settle()
        render(900) // past the note end (960) and the second cycle start (3840)
        expect(records.map(record => record.status), "released, the looped start dropped").toEqual([0x90 | CHANNEL, 0x80 | CHANNEL])
        source.beginTransaction()
        asDefined(cell).mute.setValue(false)
        source.endTransaction()
        await sync.settle()
        render(800) // past the third cycle start (7680)
        expect(records.filter(record => record.status === (0x90 | CHANNEL)).length, "unmuted, the next cycle plays").toBe(2)
    }, 60000)
})
