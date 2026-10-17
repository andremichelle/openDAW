import {int, isDefined, Nullable, Procedure} from "@opendaw/lib-std"
import {Port} from "@opendaw/lib-runtime"
import {BridgeShared, LiveLock, SyncState, ToEngine, ToStudio} from "./BridgeLink"
import {MIDISender} from "../../../../../../studio/core-processors/src/MIDISender"

// a connection that broke without a close message: the engine process went away
const AbnormalClosure = 1006

// A MessagePort stand-in that carries one engine instance's messages to the native engine process.
// It also relays the engine state stream, the sleep flag and the live stream buffers.
export class NativeEnginePort implements Port {
    onmessage: Nullable<Procedure<MessageEvent>> = null
    onmessageerror: Nullable<Procedure<MessageEvent>> = null

    readonly #url: string
    #socket: WebSocket
    #opened = false
    #attempts: int = 0
    readonly #shared: BridgeShared
    // ports handed to the engine (the MIDI out wake-up), and the writers into their rings
    readonly #ports = new Map<int, MessagePort>()
    readonly #portIds = new WeakMap<MessagePort, int>()
    readonly #midiSenders = new Map<string, MIDISender>()
    #nextPort: int = 2
    readonly #queue: Array<ArrayBuffer> = []
    readonly #sync: Uint8Array
    readonly #control: Int32Array
    readonly #returning = new Map<int, int>()
    readonly #interval: ReturnType<typeof setInterval>
    #lastControl: int
    #pendingState: Nullable<Uint8Array> = null
    #stateApplied = false

    constructor(url: string, sampleRate: number, options: Record<string, unknown>,
                readonly onLatency: Procedure<number>, readonly onInput: Procedure<{ name: string, channels: int }>,
                readonly onInputPeaks: (uuid: Uint8Array, peaks: Float32Array) => void,
                readonly onInputDevices: Procedure<ReadonlyArray<{ name: string, channels: int }>>,
                readonly onRecordData: (uuid: Uint8Array, first: number, planes: ReadonlyArray<Float32Array>) => void,
                readonly onInputLatency: Procedure<number>,
                readonly onLost: Procedure<string>,
                scripts: ReadonlyArray<string>) {
        this.#shared = new BridgeShared("studio", {idOfPort: (port: MessagePort): int => this.#link(port), portOf: (): unknown => null})
        this.#sync = new Uint8Array(options.syncStreamBuffer as SharedArrayBuffer)
        this.#control = new Int32Array(options.controlFlagsBuffer as SharedArrayBuffer)
        this.#lastControl = Atomics.load(this.#control, 0)
        this.#url = url
        this.#socket = this.#connect()
        this.#interval = setInterval(() => this.#tick(), 8)
        scripts.forEach(code => this.#send({type: "script", code}))
        this.#send({type: "create", sampleRate, options})
    }

    // a restarted engine process may still be starting, a connection that never opened is tried again
    #connect(): WebSocket {
        const socket = new WebSocket(this.#url)
        socket.binaryType = "arraybuffer"
        socket.onopen = () => {
            this.#opened = true
            this.#queue.splice(0).forEach(bytes => socket.send(bytes))
        }
        socket.onmessage = (event: MessageEvent<ArrayBuffer>) => this.#receive(event.data)
        socket.onclose = (event: CloseEvent) => {
            if (!this.#opened && this.#attempts++ < 20) {
                setTimeout(() => this.#socket = this.#connect(), 250)
                return
            }
            clearInterval(this.#interval)
            if (event.code === AbnormalClosure) {this.onLost("The audio engine stopped unexpectedly.")}
        }
        return socket
    }

    postMessage(data: unknown): void {this.#send({type: "message", data})}

    // an engine the studio terminated or lost has closed its connection
    get isOpen(): boolean {return this.#socket.readyState === WebSocket.OPEN}

    #link(port: MessagePort): int {
        const known = this.#portIds.get(port)
        if (isDefined(known)) {return known}
        const id = this.#nextPort
        this.#nextPort += 2
        this.#portIds.set(port, id)
        this.#ports.set(id, port)
        return id
    }

    // the engine's MIDI out, written into the studio's ring as the browser engine would
    #deliverMidiOut(portId: int, bufferId: int, events: ReadonlyArray<{ deviceId: string, data: Uint8Array, timeMs: number }>): void {
        const key = `${portId}:${bufferId}`
        const port = this.#ports.get(portId)
        const buffer = this.#shared.get(bufferId)
        if (!isDefined(port) || !isDefined(buffer)) {return}
        const sender = this.#midiSenders.get(key) ?? new MIDISender(port, buffer)
        this.#midiSenders.set(key, sender)
        events.forEach(({deviceId, data, timeMs}) => sender.send(deviceId, data, timeMs))
    }

    send(envelope: ToEngine): void {this.#send(envelope)}

    #send(envelope: ToEngine): void {
        const bytes = this.#shared.encode(envelope)
        if (this.#socket.readyState === WebSocket.OPEN) {
            this.#socket.send(bytes)
        } else if (!this.#opened) {
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
        } else if (envelope.type === "latency") {
            this.onLatency(envelope.seconds)
        } else if (envelope.type === "input") {
            this.onInput({name: envelope.name, channels: envelope.channels})
        } else if (envelope.type === "input-peaks") {
            this.onInputPeaks(envelope.uuid, envelope.peaks)
        } else if (envelope.type === "input-devices") {
            this.onInputDevices(envelope.devices)
        } else if (envelope.type === "record-data") {
            this.onRecordData(envelope.uuid, envelope.first, envelope.planes)
        } else if (envelope.type === "input-latency") {
            this.onInputLatency(envelope.seconds)
        } else if (envelope.type === "failed") {
            this.onLost(`The audio engine could not start. (${envelope.reason})`)
        } else if (envelope.type === "midi-out") {
            this.#deliverMidiOut(envelope.port, envelope.buffer, envelope.events)

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
