import {Func, int, isDefined, Provider, Terminable} from "@opendaw/lib-std"

type MIDIMessageCallback = (deviceId: string, data: Uint8Array, timestamp: number) => void

/// Called once per ring read, returns the conversion from the engine's context time (ms) to performance.now() time
export type MIDIClock = Provider<Func<number, number>>

export class MIDIReceiver implements Terminable {
    static create(clock: MIDIClock, callback: MIDIMessageCallback): MIDIReceiver {
        const MIDI_RING_SIZE = 2048
        const sab = new SharedArrayBuffer(MIDI_RING_SIZE * 16 + 8)
        const channel = new MessageChannel()
        return new MIDIReceiver(sab, channel, clock, callback)
    }

    static outputClock(context: BaseAudioContext, compensationMs: Provider<number>): MIDIClock {
        return () => {
            const compensation = compensationMs()
            if (context instanceof AudioContext) {
                const {contextTime, performanceTime} = context.getOutputTimestamp()
                if (isDefined(contextTime) && isDefined(performanceTime) && performanceTime > 0) {
                    return timeMs => performanceTime + timeMs - contextTime * 1000 + compensation
                }
            }
            const latency = context instanceof AudioContext ? context.outputLatency * 1000 : 20
            const now = performance.now(), base = context.currentTime * 1000
            return timeMs => now + timeMs - base + latency + compensation
        }
    }

    static readonly immediateClock: MIDIClock = () => {
        const now = performance.now()
        return timeMs => now + timeMs
    }

    readonly #sab: SharedArrayBuffer
    readonly #channel: MessageChannel
    readonly #clock: MIDIClock
    readonly #indices: Uint32Array
    readonly #ring: Uint32Array
    readonly #times: Float64Array
    readonly #messageMask: int
    readonly #onMessage: MIDIMessageCallback
    readonly #deviceIds = new Map<int, string>()

    private constructor(sab: SharedArrayBuffer, channel: MessageChannel, clock: MIDIClock, onMessage: MIDIMessageCallback) {
        this.#sab = sab
        this.#channel = channel
        this.#clock = clock
        this.#indices = new Uint32Array(sab, 0, 2)
        this.#ring = new Uint32Array(sab, 8)
        this.#times = new Float64Array(sab, 8)
        this.#messageMask = this.#times.length / 2 - 1
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
        if (readIdx === writeIdx) {return}
        const toPerformanceTime = this.#clock()
        while (readIdx !== writeIdx) {
            const packed1 = this.#ring[readIdx << 2]
            const timeMs = this.#times[(readIdx << 1) + 1]
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
            this.#onMessage(deviceId, data, toPerformanceTime(timeMs))
            readIdx = (readIdx + 1) & this.#messageMask
        }
        Atomics.store(this.#indices, 1, readIdx)
    }
}