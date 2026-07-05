// The device LIVE-DATA broadcasts (TS `context.broadcaster.broadcastFloats(adapter.address.append(...))`
// mirrors): a hot synth through compressor -> revamp -> tidal -> gate -> maximizer must register and move
// the editor slots — compressor [0] in/reduction/out, gate [0] in/out/env, maximizer [0] reduction + [1]
// input peaks, tidal [0] phase, revamp [0xFFF] spectrum (FFT runs only once the UI subscribes).
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioFileBox, AudioUnitBox, CaptureMidiBox, CompressorDeviceBox, GateDeviceBox, MaximizerDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, PlayfieldDeviceBox, PlayfieldSampleBox, RevampDeviceBox, TidalDeviceBox, TrackBox, VaporisateurDeviceBox, VelocityDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const SYNTH = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, freq: 220 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(voice => voice.id !== id) }
    process(output, block) {
        const [left, right] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const value = Math.sin(voice.phase * Math.PI * 2) * 0.9
                left[i] += value; right[i] += value
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

type Entry = {index: number, uuid: UUID.Bytes, packageType: number, ptr: number, len: number, keys: Array<number>}

const readEntries = (engine: {broadcast_count(): number, broadcast_entry(index: number, ptr: number): number, input_reserve(len: number): number}, memory: WebAssembly.Memory): Array<Entry> => {
    const count = engine.broadcast_count() >>> 0
    const entries: Array<Entry> = []
    for (let index = 0; index < count; index++) {
        const recordPtr = engine.input_reserve(48)
        if (engine.broadcast_entry(index, recordPtr) === 0) {continue}
        const record = new DataView(memory.buffer, recordPtr, 48)
        const uuid = new Uint8Array(memory.buffer, recordPtr, 16).slice() as UUID.Bytes
        const keysCount = record.getUint32(28, true)
        const keys: Array<number> = []
        for (let position = 0; position < keysCount; position++) {keys.push(record.getUint16(32 + position * 2, true))}
        entries.push({index, uuid, packageType: record.getUint32(16, true), ptr: record.getUint32(20, true), len: record.getUint32(24, true), keys})
    }
    return entries
}

const findEntry = (entries: Array<Entry>, uuid: UUID.Bytes, keys: Array<number>): Entry => {
    const entry = entries.find(candidate => UUID.equals(candidate.uuid, uuid)
        && candidate.keys.length === keys.length && candidate.keys.every((key, at) => key === keys[at]))
    expect(entry, `broadcast entry ${UUID.toString(uuid)}/[${keys.join(",")}] registered`).toBeDefined()
    return entry!
}

describe("device live data", () => {
    it("registers and moves the editor slots of compressor/gate/maximizer/tidal/revamp", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.input); box.code.setValue("// @apparat js 1 1\n" + SYNTH)
        })
        const compressor = CompressorDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(0); box.threshold.setValue(-40); box.makeup.setValue(30)
        })
        const revamp = RevampDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(1)
        })
        const tidal = TidalDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(2)
        })
        const gate = GateDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(3); box.threshold.setValue(-60)
        })
        const maximizer = MaximizerDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects); box.index.setValue(4); box.threshold.setValue(-24)
        })
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0); box.target.refer(unit); box.tracks.refer(unit.tracks)
        })
        const events = NoteEventCollectionBox.create(source, UUID.generate())
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000); box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
        })
        NoteRegionBox.create(source, UUID.generate(), box => {
            box.regions.refer(track.regions); box.events.refer(events.owners); box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
        })
        source.endTransaction()
        new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, UUID.toString(apparat.address.uuid), 1, SYNTH))()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < 40; quantum++) {engine.render()}
        const entries = readEntries(engine, memory)
        const floats = (entry: Entry) => Array.from(new Float32Array(memory.buffer, entry.ptr, entry.len))
        // Compressor editor values [input dB, reduction dB, output dB]: hot signal over a -40 dB threshold.
        const compressorEditor = findEntry(entries, compressor.address.uuid, [0])
        expect(compressorEditor.len).toBe(3)
        const [compIn, compRed, compOut] = floats(compressorEditor)
        expect(compIn, "compressor input dB is hot").toBeGreaterThan(-20)
        expect(compRed, "compressor reduces a hot signal over a -40 dB threshold").toBeLessThan(-3)
        expect(compOut, "compressor output dB present").toBeGreaterThan(-60)
        // Gate editor values [input dB, output dB, envelope dB]: open on a hot signal.
        const gateEditor = findEntry(entries, gate.address.uuid, [0])
        const [gateIn, gateOut, gateEnv] = floats(gateEditor)
        expect(gateIn).toBeGreaterThan(-40)
        expect(gateOut).toBeGreaterThan(-50)
        expect(gateEnv, "gate envelope fully open (0 dB)").toBeGreaterThan(-1)
        // Maximizer: reduction at [0] (hot signal over -12 dB threshold) + input peaks at [1].
        const maximizerReduction = findEntry(entries, maximizer.address.uuid, [0])
        expect(floats(maximizerReduction)[0], "maximizer reduces").toBeLessThan(-0.5)
        const maximizerInput = findEntry(entries, maximizer.address.uuid, [1])
        expect(maximizerInput.len).toBe(4)
        expect(floats(maximizerInput)[0], "maximizer input peak").toBeGreaterThan(0.01)
        // Tidal phase at [0] advances while playing.
        const tidalPhase = findEntry(entries, tidal.address.uuid, [0])
        const phaseA = floats(tidalPhase)[0]
        for (let quantum = 0; quantum < 20; quantum++) {engine.render()}
        const phaseB = floats(tidalPhase)[0]
        expect(phaseB, "tidal phase advances").toBeGreaterThan(phaseA)
        // Revamp spectrum at [0xFFF]: silent while unsubscribed, bins appear once the UI subscribes.
        const spectrum = findEntry(entries, revamp.address.uuid, [0xFFF])
        expect(spectrum.len).toBe(512)
        expect(Math.max(...floats(spectrum)), "no FFT while unsubscribed").toBe(0)
        engine.broadcast_set_active(spectrum.index, 1)
        for (let quantum = 0; quantum < 40; quantum++) {engine.render()}
        expect(Math.max(...floats(spectrum)), "bins carry energy once subscribed").toBeGreaterThan(0.001)
    }, 120000)

    it("streams the velocity ring, playfield pad positions and vaporisateur envelope phases", async () => {
        const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        source.beginTransaction()
        // Unit A: Velocity midi-fx -> Vaporisateur (envelope playheads + the note ring).
        const unitA = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(1)
        })
        unitA.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        const vaporisateur = VaporisateurDeviceBox.create(source, UUID.generate(), box => {box.host.refer(unitA.input)})
        const velocity = VelocityDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unitA.midiEffects); box.index.setValue(0)
        })
        // Unit B: a Playfield pad (voice positions at the pad's bare address + peaks at [1001]).
        const unitB = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(2)
        })
        unitB.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
        const playfield = PlayfieldDeviceBox.create(source, UUID.generate(), box => {box.host.refer(unitB.input)})
        const file = AudioFileBox.create(source, UUID.generate(), box => {
            box.startInSeconds.setValue(0.0); box.endInSeconds.setValue(1.0); box.fileName.setValue("synthetic")
        })
        const pad = PlayfieldSampleBox.create(source, UUID.generate(), box => {
            box.device.refer(playfield.samples); box.file.refer(file); box.index.setValue(60)
        })
        for (const unit of [unitA, unitB]) {
            const track = TrackBox.create(source, UUID.generate(), box => {
                box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0); box.target.refer(unit); box.tracks.refer(unit.tracks)
            })
            const events = NoteEventCollectionBox.create(source, UUID.generate())
            for (let note = 0; note < 4; note++) {
                NoteEventBox.create(source, UUID.generate(), box => {
                    box.events.refer(events.events); box.position.setValue(note * 960); box.duration.setValue(480)
                    box.pitch.setValue(60); box.velocity.setValue(0.8); box.cent.setValue(0)
                })
            }
            NoteRegionBox.create(source, UUID.generate(), box => {
                box.regions.refer(track.regions); box.events.refer(events.owners); box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
            })
        }
        source.endTransaction()
        const {engine, memory, drainSamples} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        drainSamples()
        await sync.settle()
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        const entries = readEntries(engine, memory)
        const floats = (entry: Entry) => Array.from(new Float32Array(memory.buffer, entry.ptr, entry.len))
        // The Vaporisateur env broadcast is gated on subscription; arm it before rendering.
        const env = findEntry(entries, vaporisateur.address.uuid, [0])
        expect(env.len).toBe(32)
        engine.broadcast_set_active(env.index, 1)
        for (let quantum = 0; quantum < 40; quantum++) {engine.render()}
        // Velocity ring at [0]: INT RING [index, ...packed]; entries carry the 1<<16 "live" bit and both bytes.
        const ring = findEntry(entries, velocity.address.uuid, [0])
        expect(ring.packageType, "the ring is an INT package").toBe(2)
        expect(ring.len).toBe(1025)
        const ints = new Int32Array(memory.buffer, ring.ptr, ring.len)
        expect(ints[0], "notes were recorded").toBeGreaterThan(0)
        const packed = ints[1]
        expect(packed & (1 << 16), "the live bit is set").toBeTruthy()
        expect(packed & 0xFF, "the input velocity byte").toBe(Math.round(0.8 * 127))
        // The worklet's consume-on-read: sentinel at the index, reset — the next note starts at 0 again.
        ints[Math.min(ints[0], 1024)] = 0
        ints[0] = 0
        // Playfield pad: voice positions at the BARE address (not the generic meter), peaks at [1001].
        const positions = findEntry(entries, pad.address.uuid, [])
        expect(positions.len, "positions replace the generic pad meter").toBe(16)
        const first = floats(positions)[0]
        expect(first, "a voice playhead is live").toBeGreaterThanOrEqual(0)
        for (let quantum = 0; quantum < 10; quantum++) {engine.render()}
        expect(floats(positions)[0], "the playhead advances").toBeGreaterThan(first)
        const padPeaks = findEntry(entries, pad.address.uuid, [1001])
        expect(padPeaks.len).toBe(4)
        expect(floats(padPeaks)[0], "the pad peak moves").toBeGreaterThan(0.001)
        // Vaporisateur envelope phases: 0..4 with the -1 sentinel after the last active voice.
        const phases = floats(env)
        expect(phases[0], "a voice envelope phase is live").toBeGreaterThanOrEqual(0)
        expect(phases[0]).toBeLessThanOrEqual(4)
        const sentinel = phases.findIndex(value => value === -1)
        expect(sentinel, "the stream is closed with -1").toBeGreaterThanOrEqual(1)
    }, 120000)
})
