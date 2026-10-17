import {int, isDefined, Nullable, Procedure} from "@opendaw/lib-std"
import {Port} from "@opendaw/lib-runtime"
import {BridgeShared, LiveLock, SyncState, ToEngine, ToStudio} from "./BridgeLink"

// An offline render's worker, run in the native engine process on a thread of its own. Message ports travel as
// relays, the engine state stream and the live stream are mirrored like the realtime engine's.
export class NativeOfflineWorker implements Port {
    onmessage: Nullable<Procedure<MessageEvent>> = null
    onmessageerror: Nullable<Procedure<MessageEvent>> = null

    readonly #socket: WebSocket
    readonly #shared: BridgeShared
    readonly #queue: Array<ArrayBuffer> = []
    readonly #ports = new Map<int, MessagePort>()
    readonly #portIds = new WeakMap<MessagePort, int>()
    readonly #returning = new Map<int, int>()
    readonly #interval: ReturnType<typeof setInterval>
    #nextPort: int = 2
    #pendingSync: Nullable<{ id: int, bytes: Uint8Array }> = null
    #syncApplied = false

    constructor(url: string) {
        this.#shared = new BridgeShared("studio", {
            idOfPort: (port: MessagePort): int => this.#link(port),
            portOf: (id: int): unknown => this.#ports.get(id)
        })
        this.#socket = new WebSocket(url)
        this.#socket.binaryType = "arraybuffer"
        this.#socket.onopen = () => this.#queue.splice(0).forEach(bytes => this.#socket.send(bytes))
        this.#socket.onmessage = (event: MessageEvent<ArrayBuffer>) => this.#receive(event.data)
        this.#socket.onclose = () => clearInterval(this.#interval)
        this.#interval = setInterval(() => this.#tick(), 8)
    }

    postMessage(data: unknown): void {this.#send({type: "message", data})}

    terminate(): void {
        clearInterval(this.#interval)
        this.#ports.forEach(port => {
            port.onmessage = null
            port.close()
        })
        this.#ports.clear()
        this.#socket.close()
    }

    #link(port: MessagePort): int {
        const known = this.#portIds.get(port)
        if (isDefined(known)) {return known}
        const id = this.#nextPort
        this.#nextPort += 2
        this.#portIds.set(port, id)
        this.#ports.set(id, port)
        port.onmessage = (event: MessageEvent) => this.#send({type: "port", id, data: event.data})
        return id
    }

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
        } else if (envelope.type === "port") {
            this.#ports.get(envelope.id)?.postMessage(envelope.data)
        } else if (envelope.type === "sync") {
            this.#pendingSync = {id: envelope.id, bytes: envelope.bytes}
            this.#applySync()
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
    #applySync(): void {
        if (this.#pendingSync === null) {return}
        const buffer = this.#shared.get(this.#pendingSync.id)
        if (!isDefined(buffer)) {return}
        const sync = new Uint8Array(buffer)
        if (this.#syncApplied && Atomics.load(sync, 0) !== SyncState.READ) {return}
        sync.set(this.#pendingSync.bytes, 1)
        Atomics.store(sync, 0, SyncState.WRITTEN)
        this.#pendingSync = null
        this.#syncApplied = true
    }

    #tick(): void {
        this.#applySync()
        this.#returning.forEach((dataId, lockId) => {
            const lock = this.#shared.get(lockId)
            const data = this.#shared.get(dataId)
            if (!isDefined(lock) || !isDefined(data) || Atomics.load(new Int8Array(lock), 0) !== LiveLock.WRITE) {return}
            this.#returning.delete(lockId)
            this.#send({type: "live-return", lock: lockId, data: dataId, bytes: new Uint8Array(data).slice()})
        })
    }
}
