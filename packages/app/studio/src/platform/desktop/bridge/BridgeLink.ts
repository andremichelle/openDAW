import {int, isDefined, Optional} from "@opendaw/lib-std"
import {BridgeCodec} from "./BridgeCodec"

// The envelopes between the studio (UI) and the native engine process, one WebSocket per engine instance
export type ToEngine =
    | { type: "create", sampleRate: number, options: Record<string, unknown> }
    | { type: "message", data: unknown }
    | { type: "control", value: int }
    | { type: "live-return", lock: int, data: int, bytes: Uint8Array }
    | { type: "capture", uuid: Uint8Array, deviceId: string, channels: int, gain: number, mode: string, volume: number, pan: number }
    | { type: "capture-close", uuid: Uint8Array }
    | { type: "record", uuid: Uint8Array, record: boolean }
    | { type: "native-save" }
    | { type: "native-gui", uuid: string, open: boolean }
    | { type: "port", id: int, data: unknown }
    | { type: "script", code: string }

export type ToStudio =
    | { type: "message", data: unknown }
    | { type: "state", bytes: Uint8Array }
    | { type: "live", lock: int, data: int, bytes: Uint8Array }
    | { type: "latency", seconds: number }
    | { type: "input", name: string, channels: int }
    | { type: "input-peaks", uuid: Uint8Array, peaks: Float32Array }
    | { type: "input-devices", devices: Array<{ name: string, channels: int }> }
    | { type: "record-data", uuid: Uint8Array, first: number, planes: Array<Float32Array> }
    | { type: "input-latency", seconds: number }
    | { type: "port", id: int, data: unknown }
    | { type: "sync", id: int, bytes: Uint8Array }
    | { type: "midi-out", port: int, buffer: int, events: Array<{ deviceId: string, data: Uint8Array, timeMs: number }> }
    | { type: "failed", reason: string }

export const enum LiveLock {WRITE = 0, READ = 1}
export const enum SyncState {READING = 0, READ = 1, WRITING = 2, WRITTEN = 3}

export type BridgePorts = { idOfPort(port: MessagePort): int, portOf(id: int): unknown }

// Each side numbers the buffers it sends (UI even, engine odd) and creates its own copy of a buffer it receives
export class BridgeShared implements BridgeCodec.SharedBuffers {
    readonly #byId = new Map<int, SharedArrayBuffer>()
    readonly #ids = new WeakMap<SharedArrayBuffer, int>()
    readonly #received = new Set<int>()
    readonly #ports: Optional<BridgePorts>
    #next: int

    constructor(side: "studio" | "engine", ports?: BridgePorts) {
        this.#next = side === "studio" ? 2 : 1
        this.#ports = ports
    }

    idOfPort(port: MessagePort): Optional<int> {return this.#ports?.idOfPort(port)}
    portOf(id: int): unknown {return this.#ports?.portOf(id)}

    idOf(buffer: SharedArrayBuffer): int {
        const known = this.#ids.get(buffer)
        if (isDefined(known)) {return known}
        const id = this.#next
        this.#next += 2
        this.#ids.set(buffer, id)
        this.#byId.set(id, buffer)
        return id
    }

    bufferOf(id: int, byteLength: int): SharedArrayBuffer {
        const known = this.#byId.get(id)
        if (isDefined(known)) {return known}
        const buffer = new SharedArrayBuffer(byteLength)
        this.#byId.set(id, buffer)
        this.#ids.set(buffer, id)
        this.#received.add(id)
        return buffer
    }

    get(id: int): Optional<SharedArrayBuffer> {return this.#byId.get(id)}
    // the buffers this side created and sent, in the order they were first sent
    own(): ReadonlyArray<[int, SharedArrayBuffer]> {
        return Array.from(this.#byId.entries()).filter(([id]) => !this.#received.has(id)).sort(([left], [right]) => left - right)
    }
    isReceived(id: int): boolean {return this.#received.has(id)}
    encode(value: ToEngine | ToStudio): ArrayBuffer {return BridgeCodec.encode(value, this)}
    decode<T extends ToEngine | ToStudio>(bytes: ArrayBuffer): T {return BridgeCodec.decode(bytes, this) as T}
}
