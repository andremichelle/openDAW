import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Option, Terminable, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {MIDISender} from "../../core-processors/src/MIDISender"
import {MIDIClock, MIDIReceiver} from "../../core/src/midi/MIDIReceiver"
import {MidiDevices} from "../../core/src/midi/MidiDevices"
import type {ProjectEnv} from "../../core/src/project/ProjectEnv"
import type {Project} from "../../core/src/project/Project"

// Issue #356: hardware MIDI output swung when the main thread was busy.
// The engine stamped each message relative to the quantum it rendered and the main thread added that to
// performance.now() at the moment it read the ring, so any delay of that read landed on the note.
// These tests drive the real MIDISender -> MIDIReceiver -> Project.sendMIDIFromEngine path with a fake clock.
// The engine side mirrors WasmMidiDrain: quantum context time + (offset in quantum + delayInMs).
// The fake AudioContext runs its context time PERF_OFFSET_MS behind performance.now(), a rendered frame
// becomes audible OUTPUT_LATENCY_MS after it was rendered, exactly what getOutputTimestamp reports.

const DEVICE_ID = "hardware-synth"
const SAMPLE_RATE = 48_000
const QUANTUM_MS = 128 / SAMPLE_RATE * 1000
const DELAY_MS = 10 // MIDIOutputDevice delayInMs
const OUTPUT_LATENCY_MS = 23.4
const PERF_OFFSET_MS = 12_345.678
const NOTE_INTERVAL_MS = 60_000 / 140 / 8 // 1/32 at 140 bpm
const NOTE_LENGTH_MS = NOTE_INTERVAL_MS / 2

type MidiEvent = { timeMs: number, data: Uint8Array }
type Sent = { data: Uint8Array, timestamp: number }
type Clock = { contextMs: number, timestampAvailable: boolean, compensationMs: number }

const clock: Clock = {contextMs: 0, timestampAvailable: true, compensationMs: 0}

class FakeAudioContext {
    get currentTime(): number {return clock.contextMs / 1000}
    get outputLatency(): number {return OUTPUT_LATENCY_MS / 1000}
    getOutputTimestamp(): AudioTimestamp {
        if (!clock.timestampAvailable) {return {contextTime: 0, performanceTime: 0}}
        const performanceTime = clock.contextMs + PERF_OFFSET_MS
        return {contextTime: (clock.contextMs - OUTPUT_LATENCY_MS) / 1000, performanceTime}
    }
}

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None},
            get peaks() {return Option.None},
            get uuid() {return uuid},
            get state() {return {type: "idle"} as const},
            invalidate() {},
            subscribe: () => Terminable.Empty
        }),
        record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

// Note on/off pairs of a 1/32 pattern, the first starting at startMs.
const pattern = (startMs: number, count: number): ReadonlyArray<MidiEvent> =>
    Array.from({length: count}, (_, index) => {
        const onMs = startMs + index * NOTE_INTERVAL_MS
        return [
            {timeMs: onMs, data: new Uint8Array([0x90, 36 + index % 12, 100])},
            {timeMs: onMs + NOTE_LENGTH_MS, data: new Uint8Array([0x80, 36 + index % 12, 0])}
        ]
    }).flat()

// When the hardware should receive an event: the moment its frame is heard plus the device delay and compensation.
const expectedTimestamp = (event: MidiEvent): number =>
    event.timeMs + PERF_OFFSET_MS + OUTPUT_LATENCY_MS + DELAY_MS + clock.compensationMs

const maxDeviation = (sent: ReadonlyArray<Sent>, events: ReadonlyArray<MidiEvent>): number =>
    Math.max(...sent.map((message, index) => Math.abs(message.timestamp - expectedTimestamp(events[index]))))

const deliver = async (): Promise<void> => {
    for (let pass = 0; pass < 4; pass++) {await new Promise(resolve => setImmediate(resolve))}
}

// Deterministic pseudo random numbers in [0, 1).
const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
}

// An 80 ms synchronous task every 500 ms, as in the measurement on the issue.
const periodicBlocks = (renderMs: number) => renderMs % 500 >= 100 && renderMs % 500 < 180

describe("MIDI output timing (#356)", () => {
    let project: Project
    let receivers: Array<MIDIReceiver>
    let sent: Array<Sent>
    let notified: Array<string>
    beforeEach(async () => {
        clock.contextMs = 0
        clock.timestampAvailable = true
        clock.compensationMs = 0
        sent = []
        notified = []
        receivers = []
        vi.spyOn(performance, "now").mockImplementation(() => clock.contextMs + PERF_OFFSET_MS)
        Reflect.set(globalThis, "AudioContext", FakeAudioContext)
        const output = {
            id: DEVICE_ID,
            send: (data: Uint8Array, timestamp: number) => {sent.push({data: Uint8Array.from(data), timestamp})}
        } as unknown as MIDIOutput
        vi.spyOn(MidiDevices, "findOutputDeviceById")
            .mockImplementation(id => id === DEVICE_ID ? Option.wrap(output) : Option.None)
        const {Project} = await import("../../core/src/project/Project")
        project = Project.fromSkeleton(createEnv(),
            ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false}))
        project.subscribeMIDIOut(message => notified.push(message.deviceId))
    })
    afterEach(() => {
        receivers.forEach(receiver => {
            receiver.port.close()
            receiver.terminate()
        })
        Reflect.deleteProperty(globalThis, "AudioContext")
        vi.restoreAllMocks()
    })

    const fakeContext = (): BaseAudioContext => new FakeAudioContext() as unknown as BaseAudioContext

    // The EngineWorklet wiring, with a replaceable clock.
    const connect = (midiClock: MIDIClock = MIDIReceiver.outputClock(fakeContext(), () => clock.compensationMs)) => {
        const receiver = MIDIReceiver.create(midiClock,
            (deviceId, data, timestamp) => project.sendMIDIFromEngine(deviceId, data, timestamp))
        receivers.push(receiver)
        return new MIDISender(receiver.port, receiver.sab)
    }

    // Renders quanta from fromMs to toMs like the engine does: each event goes out in the quantum covering its
    // time, stamped like WasmMidiDrain does. When blocked returns true for a quantum, the main thread does not
    // get to read the ring until the block ends.
    const render = async (sender: MIDISender, events: ReadonlyArray<MidiEvent>, fromMs: number, toMs: number,
                          blocked: (renderMs: number) => boolean, deviceId: string = DEVICE_ID): Promise<void> => {
        const firstQuantum = Math.floor(fromMs / QUANTUM_MS)
        const lastQuantum = Math.ceil(toMs / QUANTUM_MS)
        for (let quantum = firstQuantum; quantum < lastQuantum; quantum++) {
            const renderMs = quantum * QUANTUM_MS
            clock.contextMs = renderMs
            events
                .filter(event => event.timeMs >= renderMs && event.timeMs < renderMs + QUANTUM_MS)
                .forEach(event => sender.send(deviceId, event.data, renderMs + (event.timeMs - renderMs + DELAY_MS)))
            if (!blocked(renderMs)) {await deliver()}
        }
        await deliver()
    }

    it("stamps every message from its render time when the main thread is idle", async () => {
        const events = pattern(5, 16)
        await render(connect(), events, 0, 1000, () => false)
        expect(sent.length).toBe(events.length)
        expect(maxDeviation(sent, events)).toBeLessThan(1e-6)
    })

    it("keeps sub-millisecond offsets inside the quantum", async () => {
        const events = pattern(5.4, 16)
        await render(connect(), events, 0, 1000, () => false)
        expect(sent.length).toBe(events.length)
        sent.forEach((message, index) => expect(message.timestamp).toBeCloseTo(expectedTimestamp(events[index]), 6))
    })

    it("does not shift messages that were rendered while the main thread was blocked", async () => {
        const events = pattern(5, 36)
        await render(connect(), events, 0, 2000, periodicBlocks)
        expect(sent.length).toBe(events.length)
        expect(maxDeviation(sent, events)).toBeLessThan(1e-6)
    })

    it("never sends a note-off before its note-on while the main thread is blocked", async () => {
        const events = pattern(5, 36)
        await render(connect(), events, 0, 2000, periodicBlocks)
        expect(sent.length).toBe(events.length)
        const pairs = Array.from({length: sent.length / 2}, (_, index) => [sent[index * 2], sent[index * 2 + 1]])
        pairs.forEach(([noteOn, noteOff]) => {
            expect(noteOn.data[0]).toBe(0x90)
            expect(noteOff.data[0]).toBe(0x80)
        })
        const inverted = pairs.filter(([noteOn, noteOff]) => noteOff.timestamp <= noteOn.timestamp)
        expect(inverted.length).toBe(0)
        const lengths = pairs.map(([noteOn, noteOff]) => noteOff.timestamp - noteOn.timestamp)
        expect(Math.max(...lengths.map(length => Math.abs(length - NOTE_LENGTH_MS)))).toBeLessThan(1e-6)
    })

    it("survives one long freeze (a tab switch or a GC pause of 1.5 s)", async () => {
        const events = pattern(3, 60)
        await render(connect(), events, 0, 3500, renderMs => renderMs >= 400 && renderMs < 1900)
        expect(sent.length).toBe(events.length)
        expect(maxDeviation(sent, events)).toBeLessThan(1e-6)
    })

    it("stays exact under irregular random blocks with 1/64 notes at 174 bpm over 10 s", async () => {
        const next = random(356)
        const interval = 60_000 / 174 / 16
        const events = Array.from({length: Math.floor(10_000 / interval)}, (_, index) => {
            const onMs = 1 + index * interval + next() * 0.9
            return [
                {timeMs: onMs, data: new Uint8Array([0x90, 40 + index % 24, 1 + Math.floor(next() * 126)])},
                {timeMs: onMs + interval * 0.4, data: new Uint8Array([0x80, 40 + index % 24, 0])}
            ]
        }).flat().sort((first, second) => first.timeMs - second.timeMs)
        const blocks = new Set<number>()
        for (let quantum = 0; quantum < 10_100 / QUANTUM_MS; quantum++) {
            if (next() < 0.02) {
                const length = 1 + Math.floor(next() * 60)
                for (let index = 0; index < length; index++) {blocks.add(quantum + index)}
            }
        }
        await render(connect(), events, 0, 10_100, renderMs => blocks.has(Math.round(renderMs / QUANTUM_MS)))
        expect(sent.length).toBe(events.length)
        expect(maxDeviation(sent, events)).toBeLessThan(1e-6)
        sent.slice(1).forEach((message, index) => expect(message.timestamp).toBeGreaterThanOrEqual(sent[index].timestamp))
    })

    it("falls back to currentTime and outputLatency before the context reports an output timestamp", async () => {
        clock.timestampAvailable = false
        const events = pattern(5, 36)
        await render(connect(), events, 0, 2000, periodicBlocks)
        expect(sent.length).toBe(events.length)
        expect(maxDeviation(sent, events)).toBeLessThan(1e-6)
    })

    it("does not jump when the output timestamp becomes available mid-stream", async () => {
        clock.timestampAvailable = false
        const sender = connect()
        const events = pattern(5, 36)
        await render(sender, events, 0, 1000, periodicBlocks)
        clock.timestampAvailable = true
        await render(sender, events, 1000, 2000, periodicBlocks)
        expect(sent.length).toBe(events.length)
        expect(maxDeviation(sent, events)).toBeLessThan(1e-6)
    })

    it("uses 20 ms output latency for a context that is no AudioContext", async () => {
        const offline = {get currentTime() {return clock.contextMs / 1000}} as unknown as BaseAudioContext
        const events = pattern(5, 16)
        await render(connect(MIDIReceiver.outputClock(offline, () => 0)), events, 0, 1000, periodicBlocks)
        expect(sent.length).toBe(events.length)
        sent.forEach((message, index) =>
            expect(message.timestamp).toBeCloseTo(events[index].timeMs + PERF_OFFSET_MS + 20 + DELAY_MS, 6))
    })

    it("adds the latency compensation as it is at the moment of the read", async () => {
        const sender = connect()
        const first = pattern(5, 10)
        await render(sender, first, 0, 600, () => false)
        const firstSent = sent.splice(0)
        expect(maxDeviation(firstSent, first)).toBeLessThan(1e-6)
        clock.compensationMs = 37.5
        const second = pattern(605, 10)
        await render(sender, second, 600, 1200, () => false)
        expect(maxDeviation(sent, second)).toBeLessThan(1e-6)
    })

    it("asks the clock once per ring read, not per message", async () => {
        let reads = 0
        const outputClock = MIDIReceiver.outputClock(fakeContext(), () => 0)
        const sender = connect(() => {
            reads++
            return outputClock()
        })
        const events = pattern(5, 36)
        await render(sender, events, 0, 2000, periodicBlocks)
        expect(sent.length).toBe(events.length)
        expect(reads).toBeGreaterThan(0)
        expect(reads).toBeLessThan(events.length)
    })

    it("immediateClock (offline renderer) sends at performance.now() plus the time", async () => {
        const sender = connect(MIDIReceiver.immediateClock)
        sender.send(DEVICE_ID, new Uint8Array([0x90, 60, 100]), 10.25)
        await deliver()
        expect(sent).toEqual([{data: new Uint8Array([0x90, 60, 100]), timestamp: PERF_OFFSET_MS + 10.25}])
    })

    it("keeps the relative receivedMIDIFromEngine for SDK users", () => {
        clock.contextMs = 1000
        project.receivedMIDIFromEngine(DEVICE_ID, new Uint8Array([0xB0, 7, 64]), 12.5)
        expect(sent).toEqual([{data: new Uint8Array([0xB0, 7, 64]), timestamp: 1000 + PERF_OFFSET_MS + 12.5}])
        expect(notified).toEqual([DEVICE_ID])
    })

    it("notifies every message once, also those for a device that is not connected", async () => {
        const sender = connect()
        const events = pattern(5, 4)
        await render(sender, events, 0, 300, () => false)
        await render(sender, events.map(event => ({...event, timeMs: event.timeMs + 300})), 300, 600, () => false, "gone")
        expect(sent.length).toBe(events.length)
        expect(notified).toEqual([...events.map(() => DEVICE_ID), ...events.map(() => "gone")])
    })

    it("drops what overflows the ring during a freeze and stays exact afterwards", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {})
        const sender = connect()
        clock.contextMs = 0
        const flood = Array.from({length: 3000}, (_, index) =>
            sender.send(DEVICE_ID, new Uint8Array([0xF8]), index * 0.01))
        expect(flood.filter(accepted => accepted).length).toBe(2047)
        await deliver()
        expect(sent.length).toBe(2047)
        sent.forEach((message, index) =>
            expect(message.timestamp).toBeCloseTo(index * 0.01 + PERF_OFFSET_MS + OUTPUT_LATENCY_MS, 6))
        sent.length = 0
        const events = pattern(1005, 20)
        await render(sender, events, 1000, 2200, periodicBlocks)
        expect(sent.length).toBe(events.length)
        expect(maxDeviation(sent, events)).toBeLessThan(1e-6)
    })
})
