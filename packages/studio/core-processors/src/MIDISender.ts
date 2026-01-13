import {int, isUndefined} from "@moises-ai/lib-std"

export class MIDISender {
    readonly #port: MessagePort
    readonly #indices: Uint32Array
    readonly #ring: Uint32Array
    readonly #ringMask: int

    readonly #deviceIdToNum = new Map<string, number>()
    readonly #numToDeviceId: Array<string> = []

    constructor(port: MessagePort, sab: SharedArrayBuffer) {
        this.#port = port
        this.#indices = new Uint32Array(sab, 0, 2)
        this.#ring = new Uint32Array(sab, 8)
        this.#ringMask = (this.#ring.length >> 1) - 1
    }

    send(deviceId: string, data: Uint8Array, timeMs: number): boolean {
        let deviceNum = this.#deviceIdToNum.get(deviceId)
        if (isUndefined(deviceNum)) {
            deviceNum = this.#numToDeviceId.length
            if (deviceNum >= 64) {
                console.error(`Too many MIDI devices: ${deviceNum}, max is 64`)
                return false
            }
            this.#deviceIdToNum.set(deviceId, deviceNum)
            this.#numToDeviceId.push(deviceId)
            this.#port.postMessage({registerDevice: deviceId, id: deviceNum}) // registers the device with a simple integer ID
        }
        const writeIdx = Atomics.load(this.#indices, 0)
        const nextIdx = (writeIdx + 1) & this.#ringMask
        if (nextIdx === Atomics.load(this.#indices, 1)) {
            return false
        }
        const length = data.length
        const status = data[0] ?? 0
        const data1 = data[1] ?? 0
        const data2 = data[2] ?? 0
        const packed1 = (length << 30) | (deviceNum << 24) | (status << 16) | (data1 << 8) | data2
        const packed2 = timeMs | 0
        const offset = writeIdx << 1
        this.#ring[offset] = packed1
        this.#ring[offset + 1] = packed2
        Atomics.store(this.#indices, 0, nextIdx)
        this.#port.postMessage(null) // signals the MIDIReceiver to read messages from the ring buffer
        return true
    }
}