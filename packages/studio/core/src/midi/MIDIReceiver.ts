import {int, Provider, Terminable} from "@moises-ai/lib-std"

type MIDIMessageCallback = (deviceId: string, data: Uint8Array, timeMs: int) => void

export class MIDIReceiver implements Terminable {
    static create(outputLatencyProvider: Provider<number>, callback: MIDIMessageCallback): MIDIReceiver {
        const MIDI_RING_SIZE = 2048
        const sab = new SharedArrayBuffer(MIDI_RING_SIZE * 2 * 4 + 8)
        const channel = new MessageChannel()
        return new MIDIReceiver(sab, channel, (deviceId: string, data: Uint8Array, relativeTimeInMs: int) => {
            callback(deviceId, data, relativeTimeInMs + outputLatencyProvider())
        })
    }

    readonly #sab: SharedArrayBuffer
    readonly #channel: MessageChannel
    readonly #indices: Uint32Array
    readonly #ring: Uint32Array
    readonly #messageMask: int
    readonly #onMessage: MIDIMessageCallback
    readonly #deviceIds = new Map<int, string>()

    private constructor(sab: SharedArrayBuffer, channel: MessageChannel, onMessage: MIDIMessageCallback) {
        this.#sab = sab
        this.#channel = channel

        this.#indices = new Uint32Array(sab, 0, 2)
        this.#ring = new Uint32Array(sab, 8)
        this.#messageMask = (this.#ring.length >> 1) - 1
        this.#onMessage = onMessage
        this.#channel.port1.onmessage = (event) => {
            if (event.data?.registerDevice) {
                this.#deviceIds.set(event.data.id, event.data.registerDevice)
            }
            this.#read()
        }
    }

    get sab(): SharedArrayBuffer {return this.#sab}
    get port(): MessagePort {return this.#channel.port2}

    terminate(): void {this.#channel.port1.close()}

    #read(): void {
        let readIdx = Atomics.load(this.#indices, 1)
        const writeIdx = Atomics.load(this.#indices, 0)
        while (readIdx !== writeIdx) {
            const offset = readIdx << 1
            const packed1 = this.#ring[offset]
            const packed2 = this.#ring[offset + 1]
            const length = packed1 >>> 30
            const deviceIdNum = (packed1 >>> 24) & 0x3F
            const status = (packed1 >>> 16) & 0xFF
            const data1 = (packed1 >>> 8) & 0xFF
            const data2 = packed1 & 0xFF
            const deviceId = this.#deviceIds.get(deviceIdNum) ?? ""
            const data = new Uint8Array(length)
            data[0] = status
            if (length > 1) {data[1] = data1}
            if (length > 2) {data[2] = data2}
            this.#onMessage(deviceId, data, packed2)
            readIdx = (readIdx + 1) & this.#messageMask
        }
        Atomics.store(this.#indices, 1, readIdx)
    }
}