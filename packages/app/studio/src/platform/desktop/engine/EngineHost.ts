// The native engine host, shipped in the desktop web build as engine-host.js and run by the engine process:
// an AudioWorkletGlobalScope stand-in for the unchanged wasm-processor bundle, one processor per studio connection.
import {int, isDefined, Nullable, Optional, Procedure, tryCatch} from "@opendaw/lib-std"
import {Port} from "@opendaw/lib-runtime"
import {loadEngineModules} from "../../../../../../studio/core-wasm/src/engine-modules"
import {WASM_ENGINE_PROCESSOR_NAME} from "../../../../../../studio/core-wasm/src/protocol"
import {BridgeShared, LiveLock, SyncState, ToEngine, ToStudio} from "../bridge/BridgeLink"

declare const __send: (connection: int, bytes: ArrayBuffer) => void
declare const __close: (connection: int) => void
declare const __outputLatency: () => number

const RenderQuantum = 128
const TickQuanta = 4

type Processor = { process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean }
type ProcessorClass = new (options: { processorOptions: Record<string, unknown> }) => Processor
type Scope = Record<string, unknown>

const scope = globalThis as unknown as Scope
const processorClasses = new Map<string, ProcessorClass>()
const construction: { port: Optional<Port> } = {port: undefined}

scope.registerProcessor = (name: string, processorClass: ProcessorClass): void => {processorClasses.set(name, processorClass)}
scope.AudioWorkletProcessor = class {
    readonly port: Port
    constructor() {
        const port = construction.port
        if (!isDefined(port)) {throw new Error("AudioWorkletProcessor constructed outside the host")}
        this.port = port
    }
}
scope.MessagePort = class {}
scope.sampleRate = 48_000
scope.currentFrame = 0
scope.currentTime = 0

const modules = new Map<string, ReturnType<typeof loadEngineModules>>()

class EnginePort implements Port {
    onmessage: Nullable<Procedure<MessageEvent>> = null
    onmessageerror: Nullable<Procedure<MessageEvent>> = null
    constructor(readonly connection: Connection) {}
    postMessage(data: unknown): void {this.connection.send({type: "message", data})}
}

class Connection {
    readonly shared = new BridgeShared("engine")
    readonly port: EnginePort = new EnginePort(this)
    readonly queue: Array<ToEngine> = []
    readonly inFlight = new Set<int>()
    readonly main = [new Float32Array(RenderQuantum), new Float32Array(RenderQuantum)]
    readonly monitor = Array.from({length: 8}, () => new Float32Array(RenderQuantum))
    processor: Nullable<Processor> = null
    sync: Nullable<Uint8Array> = null
    control: Nullable<Int32Array> = null
    alive = true
    ticks = 0

    constructor(readonly id: int) {}

    receive(bytes: ArrayBuffer): void {
        const envelope = this.shared.decode<ToEngine>(bytes)
        if (envelope.type === "create") {
            this.#create(envelope.sampleRate, envelope.options).catch(error => {
                console.error(`[host] engine ${this.id} failed to start`, error?.stack ?? error)
                this.close()
            })
        } else if (this.processor === null) {
            this.queue.push(envelope)
        } else {
            this.#handle(envelope)
        }
    }

    send(envelope: ToStudio): void {__send(this.id, this.shared.encode(envelope))}

    render(): void {
        if (!this.alive || this.processor === null) {return}
        this.main.forEach(channel => channel.fill(0.0))
        const {status, value, error} = tryCatch(() => this.processor?.process([[]], [this.main, this.monitor]) ?? false)
        if (status === "failure") {console.error(`[host] engine ${this.id} threw`, (error as Error)?.stack ?? error)}
        this.alive = status === "success" && value
        if (!this.alive) {this.close()}
    }

    tick(): void {
        if (this.ticks++ % 100 === 0) {this.send({type: "latency", seconds: __outputLatency()})}
        if (this.sync !== null && Atomics.load(this.sync, 0) === SyncState.WRITTEN) {
            this.send({type: "state", bytes: this.sync.slice(1)})
            Atomics.store(this.sync, 0, SyncState.READ)
        }
        const own = this.shared.own()
        const data = own.filter(([, buffer]) => buffer.byteLength > 1).at(-1)
        if (!isDefined(data)) {return}
        own.filter(([, buffer]) => buffer.byteLength === 1).forEach(([lockId, lock]) => {
            if (this.inFlight.has(lockId) || Atomics.load(new Int8Array(lock), 0) !== LiveLock.READ) {return}
            this.inFlight.add(lockId)
            this.send({type: "live", lock: lockId, data: data[0], bytes: new Uint8Array(data[1]).slice()})
        })
    }

    close(): void {
        this.alive = false
        __close(this.id)
    }

    async #create(sampleRate: number, options: Record<string, unknown>): Promise<void> {
        scope.sampleRate = sampleRate
        const variant = options.variant as { wasmUrl: string }
        const loading = modules.get(variant.wasmUrl) ?? loadEngineModules(variant.wasmUrl)
        modules.set(variant.wasmUrl, loading)
        const {engineModule, deviceModules, deviceBoxTypes, composites, effectComposites} = await loading
        this.sync = new Uint8Array(options.syncStreamBuffer as SharedArrayBuffer)
        this.control = new Int32Array(options.controlFlagsBuffer as SharedArrayBuffer)
        const processorClass = processorClasses.get(WASM_ENGINE_PROCESSOR_NAME)
        if (!isDefined(processorClass)) {throw new Error("wasm-processor bundle not loaded")}
        construction.port = this.port
        this.processor = new processorClass({
            processorOptions: {...options, variant: {engineModule, deviceModules, deviceBoxTypes, composites, effectComposites}}
        })
        construction.port = undefined
        this.queue.splice(0).forEach(envelope => this.#handle(envelope))
        console.log(`[host] engine ${this.id} running at ${sampleRate} Hz`)
    }

    #handle(envelope: ToEngine): void {
        if (envelope.type === "message") {
            this.port.onmessage?.({data: envelope.data} as MessageEvent)
        } else if (envelope.type === "control" && this.control !== null) {
            Atomics.store(this.control, 0, envelope.value)
        } else if (envelope.type === "live-return") {
            const data = this.shared.get(envelope.data)
            const lock = this.shared.get(envelope.lock)
            this.inFlight.delete(envelope.lock)
            if (!isDefined(data) || !isDefined(lock)) {return}
            new Uint8Array(data).set(envelope.bytes)
            Atomics.store(new Int8Array(lock), 0, LiveLock.WRITE)
        }
    }
}

const connections = new Map<int, Connection>()
const state = {quanta: 0}

const render = (out: Float32Array): void => {
    out.fill(0.0)
    connections.forEach(connection => {
        connection.render()
        if (!connection.alive) {return}
        const [left, right] = connection.main
        for (let index = 0; index < RenderQuantum; index++) {
            out[index * 2] += left[index]
            out[index * 2 + 1] += right[index]
        }
    })
    scope.currentFrame = (scope.currentFrame as number) + RenderQuantum
    scope.currentTime = (scope.currentFrame as number) / (scope.sampleRate as number)
    if (++state.quanta % TickQuanta === 0) {connections.forEach(connection => connection.tick())}
}

scope.__bridge = {
    open: (id: int): void => {connections.set(id, new Connection(id))},
    receive: (id: int, bytes: ArrayBuffer): void => connections.get(id)?.receive(bytes),
    close: (id: int): void => {connections.delete(id)},
    render
}
