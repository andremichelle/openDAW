// The engine-side LIVE BROADCAST TABLE end-to-end: a minimal leaf project (Nano over a constant sample) must
// register telemetry entries at reconcile — the unit's strip meter, the instrument's output meter and its
// note-activity counter — and rendering with playback must move the live values the worklet's
// LiveStreamBroadcaster reads straight out of wasm memory. The MASTER PEAKS slot is NOT engine-registered:
// the worklet's own PeakBroadcaster owns EngineAddresses.PEAKS (fed engine.output_ptr()), mirroring the TS
// engine, so registering it here too would collide on that single address.
import {describe, expect, it} from "vitest"
import {asDefined, UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, CaptureMidiBox, NanoDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const FRAMES = 48000
const PACKAGE_FLOAT = 0
const PACKAGE_FLOAT_ARRAY = 1

type Entry = {uuid: Uint8Array, packageType: number, ptr: number, len: number, keys: Array<number>}

const build = () => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0)
        box.endInSeconds.setValue(1.0)
        box.fileName.setValue("const")
    })
    const nano = NanoDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.file.refer(file)
        box.release.setValue(1.0)
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
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    source.endTransaction()
    return {source, unitUuid: unit.address.uuid, nanoUuid: nano.address.uuid}
}

// Read the whole broadcast table through the worklet's record protocol: one fixed 48-byte record per entry,
// `[uuid 16][package_type u32][ptr u32][len u32][keys_count u32][keys u16 x 8]`, little-endian.
const readEntries = (engine: any, memory: WebAssembly.Memory): Array<Entry> => {
    const count = engine.broadcast_count() >>> 0
    const entries: Array<Entry> = []
    for (let index = 0; index < count; index++) {
        const recordPtr = engine.input_reserve(48)
        expect(engine.broadcast_entry(index, recordPtr)).toBe(1)
        const record = new DataView(memory.buffer, recordPtr, 48)
        const uuid = new Uint8Array(memory.buffer, recordPtr, 16).slice()
        const keysCount = record.getUint32(28, true)
        const keys: Array<number> = []
        for (let position = 0; position < keysCount; position++) {keys.push(record.getUint16(32 + position * 2, true))}
        entries.push({uuid, packageType: record.getUint32(16, true), ptr: record.getUint32(20, true), len: record.getUint32(24, true), keys})
    }
    return entries
}

const findEntry = (entries: Array<Entry>, uuid: Uint8Array, keys: Array<number>, packageType?: number): Entry => {
    const entry = entries.find(candidate => UUID.equals(candidate.uuid as UUID.Bytes, uuid as UUID.Bytes)
        && (packageType === undefined || candidate.packageType === packageType)
        && candidate.keys.length === keys.length && candidate.keys.every((key, at) => key === keys[at]))
    return asDefined(entry, `entry ${UUID.toString(uuid as UUID.Bytes)}/${keys.join(",")} registered`)
}

describe("live broadcast table", () => {
    it("registers meter + activity slots and the values move under playback", async () => {
        const {source, unitUuid, nanoUuid} = build()
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, source)
        await sync.settle(); engine.bind(); await sync.settle()
        for (; ;) {
            const requestPtr = engine.input_reserve(16)
            const handle = engine.sample_take_request(requestPtr)
            if (handle < 0) {break}
            const pointer = engine.sample_allocate(handle, FRAMES * 4)
            new Float32Array(memory.buffer, pointer, FRAMES).fill(0.25)
            engine.sample_set_ready(handle, FRAMES, 1, 48000)
        }
        await sync.settle()
        engine.set_metronome_enabled(0)
        const generation = engine.broadcast_generation() >>> 0
        expect(generation).toBeGreaterThan(0)
        const entries = readEntries(engine, memory)
        const strip = findEntry(entries, unitUuid, [], PACKAGE_FLOAT_ARRAY)
        expect(strip.packageType).toBe(PACKAGE_FLOAT_ARRAY)
        expect(strip.len).toBe(4)
        const instrument = findEntry(entries, nanoUuid, [])
        expect(instrument.packageType).toBe(PACKAGE_FLOAT_ARRAY)
        expect(instrument.len).toBe(4)
        // The UNIT's 128-bit note set (TS `NoteEventInstrument`'s `NoteBroadcaster` at the unit address):
        // an Integers package next to the strip's Floats at the SAME address.
        const noteBits = findEntry(entries, unitUuid, [], 3)
        expect(noteBits.len).toBe(4)
        const slot = (entry: Entry): Float32Array => new Float32Array(memory.buffer, entry.ptr, entry.len)
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < 100; quantum++) {engine.render()}
        expect(slot(instrument)[0], "instrument peak L").toBeGreaterThan(0.0)
        expect(slot(instrument)[2], "instrument rms L").toBeGreaterThan(0.0)
        expect(slot(strip)[0], "strip peak L").toBeGreaterThan(0.0)
        const bits = new Int32Array(memory.buffer, noteBits.ptr, noteBits.len)
        const anyBit = bits[0] | bits[1] | bits[2] | bits[3]
        expect(anyBit, "a held note sets its unit bit").not.toBe(0)
        engine.stop()
        expect(bits[0] | bits[1] | bits[2] | bits[3], "stop clears the note bits").toBe(0)
        expect(engine.broadcast_generation() >>> 0, "rendering does not touch the table").toBe(generation)
    }, 60000)
})
