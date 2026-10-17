import {int, isDefined, Nullable} from "@opendaw/lib-std"

type Call = { message?: { func?: string, args?: Array<{ value?: unknown }> } }
type Registration = { registerDevice?: string, id?: int }

export type MidiOutEvent = { deviceId: string, data: Uint8Array, timeMs: number }

// a studio MessagePort that reached the engine process, known by its bridge id; used as a port it drops everything
export class LinkedPort {
    onmessage: null = null
    constructor(readonly id: int) {}
    postMessage(): void {}
    start(): void {}
    close(): void {}
}

const RingSize = 2048

// The engine's MIDI out in the engine process: `setupMIDI` gets a local ring in the MIDISender layout, read after every
// render; the studio writes the events into its own ring, its MIDIReceiver stays unchanged
export class MidiOutRelay {
    readonly buffer = new SharedArrayBuffer(RingSize * 2 * 4 + 8)
    readonly #indices = new Uint32Array(this.buffer, 0, 2)
    readonly #ring = new Uint32Array(this.buffer, 8)
    readonly #mask = (this.#ring.length >> 1) - 1
    readonly #deviceIds = new Map<int, string>()
    readonly #port = {
        onmessage: null, start: () => {}, close: () => {},
        postMessage: (data: Nullable<Registration>): void => {
            if (isDefined(data?.registerDevice) && isDefined(data.id)) {this.#deviceIds.set(data.id, data.registerDevice)}
        }
    }
    #target: Nullable<{ port: int, buffer: int }> = null

    // swaps the studio's ring and port in a `setupMIDI` command for the local ones, remembering the studio's
    intercept(data: unknown, bufferId: (buffer: SharedArrayBuffer) => int): void {
        const {message} = data as Call
        if (message?.func !== "setupMIDI" || !isDefined(message.args) || message.args.length < 2) {return}
        const [port, buffer] = message.args
        if (!(port.value instanceof LinkedPort) || !(buffer.value instanceof SharedArrayBuffer)) {return}
        this.#target = {port: port.value.id, buffer: bufferId(buffer.value)}
        port.value = this.#port
        buffer.value = this.buffer
    }

    get target(): Nullable<{ port: int, buffer: int }> {return this.#target}

    take(): Array<MidiOutEvent> {
        const events: Array<MidiOutEvent> = []
        let readIndex = Atomics.load(this.#indices, 1)
        const writeIndex = Atomics.load(this.#indices, 0)
        while (readIndex !== writeIndex) {
            const offset = readIndex << 1
            const packed = this.#ring[offset]
            const length = packed >>> 30
            const data = new Uint8Array(length)
            data[0] = (packed >>> 16) & 0xFF
            if (length > 1) {data[1] = (packed >>> 8) & 0xFF}
            if (length > 2) {data[2] = packed & 0xFF}
            events.push({deviceId: this.#deviceIds.get((packed >>> 24) & 0x3F) ?? "", data, timeMs: this.#ring[offset + 1] | 0})
            readIndex = (readIndex + 1) & this.#mask
        }
        Atomics.store(this.#indices, 1, readIndex)
        return events
    }
}
