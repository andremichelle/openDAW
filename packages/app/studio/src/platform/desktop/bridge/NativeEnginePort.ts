import {int, isDefined, Nullable, Procedure} from "@opendaw/lib-std"
import {Port} from "@opendaw/lib-runtime"
import {BridgeShared, LiveLock, SyncState, ToEngine, ToStudio} from "./BridgeLink"

// A MessagePort stand-in that carries one engine instance's messages to the native engine process.
// It also relays the engine state stream, the sleep flag and the live stream buffers.
export class NativeEnginePort implements Port {
    onmessage: Nullable<Procedure<MessageEvent>> = null
    onmessageerror: Nullable<Procedure<MessageEvent>> = null

    readonly #socket: WebSocket
    readonly #shared = new BridgeShared("studio")
    readonly #queue: Array<ArrayBuffer> = []
    readonly #sync: Uint8Array
    readonly #control: Int32Array
    readonly #returning = new Map<int, int>()
    readonly #interval: ReturnType<typeof setInterval>
    #lastControl: int
    #pendingState: Nullable<Uint8Array> = null
    #stateApplied = false

    constructor(url: string, sampleRate: number, options: Record<string, unknown>) {
        this.#sync = new Uint8Array(options.syncStreamBuffer as SharedArrayBuffer)
        this.#control = new Int32Array(options.controlFlagsBuffer as SharedArrayBuffer)
        this.#lastControl = Atomics.load(this.#control, 0)
        this.#socket = new WebSocket(url)
        this.#socket.binaryType = "arraybuffer"
        this.#socket.onopen = () => this.#queue.splice(0).forEach(bytes => this.#socket.send(bytes))
        this.#socket.onmessage = (event: MessageEvent<ArrayBuffer>) => this.#receive(event.data)
        this.#socket.onclose = () => clearInterval(this.#interval)
        this.#socket.onerror = () => console.warn("[NativeEngine] connection failed", url)
        this.#interval = setInterval(() => this.#tick(), 8)
        this.#send({type: "create", sampleRate, options})
    }

    postMessage(data: unknown): void {this.#send({type: "message", data})}

    #send(envelope: ToEngine): void {
        const bytes = this.#shared.encode(envelope)
        if (this.#socket.readyState === WebSocket.OPEN) {
            this.#socket.send(bytes)
        } else if (this.#socket.readyState === WebSocket.CONNECTING) {
            this.#queue.push(bytes)
        }
    }

    #receive(bytes: ArrayBuffer): void {
        const envelope = this.#shared.decode<ToStudio>(bytes)
        if (envelope.type === "message") {
            this.onmessage?.(new MessageEvent("message", {data: envelope.data}))
        } else if (envelope.type === "state") {
            this.#pendingState = envelope.bytes
            this.#applyState()
        } else if (envelope.type === "live") {
            const data = this.#shared.get(envelope.data)
            const lock = this.#shared.get(envelope.lock)
            if (!isDefined(data) || !isDefined(lock)) {return}
            new Uint8Array(data).set(envelope.bytes)
            Atomics.store(new Int8Array(lock), 0, LiveLock.READ)
            this.#returning.set(envelope.lock, envelope.data)
        }
    }

    // the reader marks a state READ once consumed; a newer state replaces one that is still pending
    #applyState(): void {
        if (this.#pendingState === null) {return}
        if (this.#stateApplied && Atomics.load(this.#sync, 0) !== SyncState.READ) {return}
        this.#sync.set(this.#pendingState, 1)
        Atomics.store(this.#sync, 0, SyncState.WRITTEN)
        this.#pendingState = null
        this.#stateApplied = true
    }

    #tick(): void {
        this.#applyState()
        const control = Atomics.load(this.#control, 0)
        if (control !== this.#lastControl) {
            this.#lastControl = control
            this.#send({type: "control", value: control})
        }
        this.#returning.forEach((dataId, lockId) => {
            const lock = this.#shared.get(lockId)
            const data = this.#shared.get(dataId)
            if (!isDefined(lock) || !isDefined(data) || Atomics.load(new Int8Array(lock), 0) !== LiveLock.WRITE) {return}
            this.#returning.delete(lockId)
            this.#send({type: "live-return", lock: lockId, data: dataId, bytes: new Uint8Array(data).slice()})
        })
    }
}
