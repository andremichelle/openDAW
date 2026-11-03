// WasmMidiDrain -> MIDISender ring: every record leaves with the context time of its quantum plus its own
// offset, at full float precision (issue #356: the old ring truncated to whole ms and carried no quantum time).
import {afterEach, describe, expect, it} from "vitest"
import {WasmMidiDrain} from "../src/midi-drain"
import {EngineExports} from "../src/engine-exports"

const RECORD_BYTES = 16
const SCRATCH = 4096

type Record = { device: number, status: number, data1: number, data2: number, length: number, timeMs: number }
type RingEntry = Record & { id: string }

const fakeEngine = (memory: WebAssembly.Memory, deviceIds: ReadonlyArray<string>) => {
    const queue: Array<Record> = []
    const lookups: Array<number> = []
    const engine = {
        midi_out_count: () => queue.length,
        input_reserve: (_length: number) => SCRATCH,
        midi_out_take: (pointer: number) => {
            const view = new DataView(memory.buffer)
            queue.forEach((record, index) => {
                const offset = pointer + index * RECORD_BYTES
                view.setUint32(offset, record.device, true)
                view.setUint8(offset + 4, record.status)
                view.setUint8(offset + 5, record.data1)
                view.setUint8(offset + 6, record.data2)
                view.setUint8(offset + 7, record.length)
                view.setFloat64(offset + 8, record.timeMs, true)
            })
            const count = queue.length
            queue.length = 0
            return count
        },
        midi_out_device_id: (num: number, pointer: number, max: number) => {
            lookups.push(num)
            const bytes = new TextEncoder().encode(deviceIds[num] ?? "")
            new Uint8Array(memory.buffer, pointer, Math.min(bytes.length, max)).set(bytes.subarray(0, max))
            return Math.min(bytes.length, max)
        }
    } as unknown as EngineExports
    return {engine, queue, lookups}
}

// Reads the ring the way MIDIReceiver does: [writeIdx u32][readIdx u32] then 16-byte slots [packed u32][pad][f64 time]
const readRing = (sab: SharedArrayBuffer, registered: Map<number, string>): Array<RingEntry> => {
    const indices = new Uint32Array(sab, 0, 2)
    const ring = new Uint32Array(sab, 8)
    const times = new Float64Array(sab, 8)
    const mask = times.length / 2 - 1
    const entries: Array<RingEntry> = []
    let readIdx = Atomics.load(indices, 1)
    const writeIdx = Atomics.load(indices, 0)
    while (readIdx !== writeIdx) {
        const packed = ring[readIdx << 2]
        const device = (packed >>> 24) & 0x3F
        entries.push({
            device, id: registered.get(device) ?? "", length: packed >>> 30, status: (packed >>> 16) & 0xFF,
            data1: (packed >>> 8) & 0xFF, data2: packed & 0xFF, timeMs: times[(readIdx << 1) + 1]
        })
        readIdx = (readIdx + 1) & mask
    }
    Atomics.store(indices, 1, readIdx)
    return entries
}

describe("WasmMidiDrain", () => {
    const channels: Array<MessageChannel> = []
    afterEach(() => {
        channels.forEach(channel => {
            channel.port1.close()
            channel.port2.close()
        })
        channels.length = 0
    })
    const connect = (drain: WasmMidiDrain, slots: number = 2048) => {
        const sab = new SharedArrayBuffer(slots * 16 + 8)
        const channel = new MessageChannel()
        channels.push(channel)
        const registered = new Map<number, string>()
        channel.port1.onmessage = event => {
            if (event.data?.registerDevice) {registered.set(event.data.id, event.data.registerDevice)}
        }
        drain.connect(channel.port2, sab)
        const settle = async () => {
            for (let pass = 0; pass < 4; pass++) {await new Promise(resolve => setImmediate(resolve))}
        }
        return {sab, registered, settle}
    }

    it("adds the quantum's context time to every record at full precision", async () => {
        const memory = new WebAssembly.Memory({initial: 1})
        const {engine, queue} = fakeEngine(memory, ["synth"])
        const drain = new WasmMidiDrain()
        const {sab, registered, settle} = connect(drain)
        queue.push({device: 0, status: 0x92, data1: 60, data2: 114, length: 3, timeMs: 10.123456789})
        queue.push({device: 0, status: 0x82, data1: 60, data2: 0, length: 3, timeMs: 12.5})
        queue.push({device: 0, status: 0xF8, data1: 0, data2: 0, length: 1, timeMs: 10})
        const quantumStartMs = 123_456_789.0 / 48_000 * 1000
        drain.drain(engine, memory, quantumStartMs)
        await settle()
        const entries = readRing(sab, registered)
        expect(entries.map(entry => entry.timeMs)).toEqual([
            quantumStartMs + 10.123456789, quantumStartMs + 12.5, quantumStartMs + 10])
        expect(entries.map(({id, status, data1, data2, length}) => ({id, status, data1, data2, length}))).toEqual([
            {id: "synth", status: 0x92, data1: 60, data2: 114, length: 3},
            {id: "synth", status: 0x82, data1: 60, data2: 0, length: 3},
            {id: "synth", status: 0xF8, data1: 0, data2: 0, length: 1}
        ])
    })

    it("keeps hours of context time exact to well below a microsecond", async () => {
        const memory = new WebAssembly.Memory({initial: 1})
        const {engine, queue} = fakeEngine(memory, ["synth"])
        const drain = new WasmMidiDrain()
        const {sab, registered, settle} = connect(drain)
        const tenHoursMs = 10 * 3600 * 1000 + 0.0625
        queue.push({device: 0, status: 0x90, data1: 1, data2: 1, length: 3, timeMs: 0.3333})
        drain.drain(engine, memory, tenHoursMs)
        await settle()
        expect(Math.abs(readRing(sab, registered)[0].timeMs - (tenHoursMs + 0.3333))).toBeLessThan(1e-6)
    })

    it("offline (quantum time 0) passes the record time through unchanged", async () => {
        const memory = new WebAssembly.Memory({initial: 1})
        const {engine, queue} = fakeEngine(memory, ["synth"])
        const drain = new WasmMidiDrain()
        const {sab, registered, settle} = connect(drain)
        queue.push({device: 0, status: 0x90, data1: 1, data2: 1, length: 3, timeMs: 10.75})
        drain.drain(engine, memory, 0)
        await settle()
        expect(readRing(sab, registered)[0].timeMs).toBe(10.75)
    })

    it("resolves each device id once and routes records per device", async () => {
        const memory = new WebAssembly.Memory({initial: 1})
        const {engine, queue, lookups} = fakeEngine(memory, ["first", "second"])
        const drain = new WasmMidiDrain()
        const {sab, registered, settle} = connect(drain)
        for (let quantum = 0; quantum < 3; quantum++) {
            queue.push({device: 1, status: 0x90, data1: quantum, data2: 1, length: 3, timeMs: 10})
            queue.push({device: 0, status: 0x91, data1: quantum, data2: 1, length: 3, timeMs: 10})
            drain.drain(engine, memory, quantum * 2.5)
        }
        await settle()
        const entries = readRing(sab, registered)
        expect(lookups).toEqual([1, 0])
        expect(entries.map(({id, data1, timeMs}) => ({id, data1, timeMs}))).toEqual([
            {id: "second", data1: 0, timeMs: 10}, {id: "first", data1: 0, timeMs: 10},
            {id: "second", data1: 1, timeMs: 12.5}, {id: "first", data1: 1, timeMs: 12.5},
            {id: "second", data1: 2, timeMs: 15}, {id: "first", data1: 2, timeMs: 15}
        ])
    })

    it("wraps around the ring without losing the time of any slot", async () => {
        const memory = new WebAssembly.Memory({initial: 1})
        const {engine, queue} = fakeEngine(memory, ["synth"])
        const drain = new WasmMidiDrain()
        const {sab, registered, settle} = connect(drain, 8)
        const seen: Array<number> = []
        for (let quantum = 0; quantum < 20; quantum++) {
            queue.push({device: 0, status: 0x90, data1: quantum, data2: 1, length: 3, timeMs: 0.25 * quantum})
            queue.push({device: 0, status: 0x80, data1: quantum, data2: 0, length: 3, timeMs: 1 + 0.25 * quantum})
            drain.drain(engine, memory, quantum * 1000 / 375)
            await settle()
            seen.push(...readRing(sab, registered).map(entry => entry.timeMs))
        }
        const expected = Array.from({length: 20}, (_, quantum) => [
            quantum * 1000 / 375 + 0.25 * quantum, quantum * 1000 / 375 + 1 + 0.25 * quantum]).flat()
        expect(seen).toEqual(expected)
    })

    it("drops the batch when no ring is connected and keeps the engine queue empty", () => {
        const memory = new WebAssembly.Memory({initial: 1})
        const {engine, queue} = fakeEngine(memory, ["synth"])
        const drain = new WasmMidiDrain()
        queue.push({device: 0, status: 0x90, data1: 1, data2: 1, length: 3, timeMs: 10})
        drain.drain(engine, memory, 5)
        expect(queue.length).toBe(0)
    })
})
