// The native engine host, shipped in the desktop web build as engine-host.js and run by the engine process:
// an AudioWorkletGlobalScope stand-in for the unchanged wasm-processor bundle, one processor per studio connection.
import {int, isDefined, Nullable, Optional, Procedure, tryCatch, UUID} from "@opendaw/lib-std"
import {Port} from "@opendaw/lib-runtime"
import {loadEngineModules} from "../../../../../../studio/core-wasm/src/engine-modules"
import {WASM_ENGINE_PROCESSOR_NAME} from "../../../../../../studio/core-wasm/src/protocol"
import {BridgeShared, LiveLock, SyncState, ToEngine, ToStudio} from "../bridge/BridgeLink"
import {NativeInstrumentBoxType, NativePlugins} from "./NativePlugins"

declare const __send: (connection: int, bytes: ArrayBuffer) => void
declare const __close: (connection: int) => void
declare const __outputLatency: () => number
declare const __openInput: (device: string) => void
declare const __closeInput: () => void
declare const __inputInfo: () => string
declare const __inputDevices: () => string
declare const __inputLatency: () => number

const RenderQuantum = 128
const SlowMessageMillis = 2

// drop-out diagnostics: the called function and the size of its payload
const describeMessage = (data: unknown, depth: int = 0): string => {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {return `${data.byteLength} bytes`}
    if (typeof data !== "object" || data === null || depth > 4) {return ""}
    const record = data as Record<string, unknown>
    const name = typeof record.func === "string" ? record.func : ""
    const inner = Object.values(record).map(value => describeMessage(value, depth + 1)).filter(text => text.length > 0).join(" ")
    return [name, inner].filter(text => text.length > 0).join(" ")
}
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

type CaptureState = {
    uuid: Uint8Array, deviceId: string, channels: int, gain: number, mode: string, volume: number, pan: number, peaks: Float32Array
    recording: boolean, first: number, planes: Array<Array<Float32Array>>
}

type InputState = { channels: int, info: string, devices: string, requested: string, views: Array<Float32Array>, buffer: Nullable<Float32Array> }

const input: InputState = {channels: 0, info: "", devices: "", requested: "", views: [], buffer: null}

// hardware input channels of a capture: the first one or two, a mono device feeds both sides
const captureChannels = (capture: CaptureState): Array<int> =>
    capture.channels === 1 ? [0] : [0, Math.min(1, Math.max(0, input.channels - 1))]

// the StereoPannerNode equal-power law, mono and stereo
const mixPanned = (target: Array<Float32Array>, left: Float32Array, right: Float32Array, stereo: boolean, volume: number, pan: number): void => {
    const [outLeft, outRight] = target
    if (!stereo) {
        const angle = (pan + 1.0) * 0.25 * Math.PI
        const gainLeft = Math.cos(angle) * volume, gainRight = Math.sin(angle) * volume
        for (let index = 0; index < RenderQuantum; index++) {
            outLeft[index] += left[index] * gainLeft
            outRight[index] += left[index] * gainRight
        }
    } else if (pan <= 0.0) {
        const angle = (pan + 1.0) * 0.5 * Math.PI
        const cos = Math.cos(angle), sin = Math.sin(angle)
        for (let index = 0; index < RenderQuantum; index++) {
            outLeft[index] += (left[index] + right[index] * cos) * volume
            outRight[index] += right[index] * sin * volume
        }
    } else {
        const angle = pan * 0.5 * Math.PI
        const cos = Math.cos(angle), sin = Math.sin(angle)
        for (let index = 0; index < RenderQuantum; index++) {
            outLeft[index] += left[index] * cos * volume
            outRight[index] += (right[index] + left[index] * sin) * volume
        }
    }
}

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
    readonly captures = new Map<string, CaptureState>()

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
        const inputs = [input.views.slice(0, input.channels)]
        const {status, value, error} = tryCatch(() => this.processor?.process(inputs, [this.main, this.monitor]) ?? false)
        if (status === "failure") {console.error(`[host] engine ${this.id} threw`, (error as Error)?.stack ?? error)}
        this.alive = status === "success" && value
        if (!this.alive) {
            this.close()
            return
        }
        this.captures.forEach(capture => {
            if (input.channels > 0) {
                captureChannels(capture).forEach((channel, index) => {
                    const samples = input.views[channel]
                    let peak = capture.peaks[index]
                    for (let frame = 0; frame < RenderQuantum; frame++) {peak = Math.max(peak, Math.abs(samples[frame]))}
                    capture.peaks[index] = peak
                })
            }
            if (capture.recording && input.channels > 0) {
                if (capture.first < 0.0) {capture.first = (scope.currentFrame as number) / (scope.sampleRate as number)}
                capture.planes.push(captureChannels(capture).map(channel => input.views[channel].map(sample => sample * capture.gain)))
            }
            if (capture.volume === 0.0 || input.channels === 0 || (capture.mode !== "direct" && capture.mode !== "effects")) {return}
            const [first, second] = captureChannels(capture)
            const source = capture.mode === "direct" ? input.views : this.monitor
            mixPanned(this.main, source[first], source[second ?? first], capture.channels === 2, capture.volume, capture.pan)
        })
    }

    // sends the collected quanta as one plane per channel; the first message carries the first quantum's engine time
    flushRecording(capture: CaptureState): void {
        if (capture.planes.length === 0) {return}
        const quanta = capture.planes
        const planes = quanta[0].map((_, channel) => {
            const plane = new Float32Array(quanta.length * RenderQuantum)
            quanta.forEach((quantum, index) => plane.set(quantum[channel], index * RenderQuantum))
            return plane
        })
        this.send({type: "record-data", uuid: capture.uuid, first: capture.first, planes})
        capture.planes = []
    }

    // effects monitoring renders the input through the unit's chain; the engine reads the mapped hardware channels
    updateMonitoringMap(): void {
        const map = Array.from(this.captures.values())
            .filter(capture => capture.mode === "effects" && input.channels > 0)
            .map(capture => ({uuid: capture.uuid, channels: captureChannels(capture)}))
        this.port.onmessage?.({data: {__id__: "42", channel: "engine-commands", message: {
            type: "send", returnId: false, func: "updateMonitoringMap", args: [{value: map}]
        }}} as MessageEvent)
    }

    tick(): void {
        if (this.ticks++ % 100 === 0) {this.send({type: "latency", seconds: __outputLatency()})}
        this.captures.forEach(capture => {if (capture.recording) {this.flushRecording(capture)}})
        if (this.ticks % 100 === 50) {this.send({type: "input-latency", seconds: __inputLatency()})}
        if (this.ticks % 2 === 0) {
            this.captures.forEach(capture => {
                this.send({type: "input-peaks", uuid: capture.uuid, peaks: capture.peaks.map(peak => peak * capture.gain)})
                capture.peaks.fill(0.0)
            })
        }
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
        const nativeModule = await NativePlugins.deviceModule(variant.wasmUrl).catch(error => {
            console.warn("[host] no native plugin device", error)
            return null
        })
        this.sync = new Uint8Array(options.syncStreamBuffer as SharedArrayBuffer)
        this.control = new Int32Array(options.controlFlagsBuffer as SharedArrayBuffer)
        const processorClass = processorClasses.get(WASM_ENGINE_PROCESSOR_NAME)
        if (!isDefined(processorClass)) {throw new Error("wasm-processor bundle not loaded")}
        construction.port = this.port
        this.processor = new processorClass({
            processorOptions: {
                ...options, variant: nativeModule === null
                    ? {engineModule, deviceModules, deviceBoxTypes, composites, effectComposites}
                    : {
                        engineModule, composites, effectComposites, hostImports: NativePlugins.imports,
                        deviceModules: [...deviceModules, nativeModule], deviceBoxTypes: [...deviceBoxTypes, NativeInstrumentBoxType]
                    }
            }
        })
        construction.port = undefined
        this.queue.splice(0).forEach(envelope => this.#handle(envelope))
        console.log(`[host] engine ${this.id} running at ${sampleRate} Hz`)
    }

    #handle(envelope: ToEngine): void {
        if (envelope.type === "message") {
            const started = performance.now()
            this.port.onmessage?.({data: envelope.data} as MessageEvent)
            const elapsed = performance.now() - started
            if (elapsed > SlowMessageMillis) {console.log(`[host] slow message ${describeMessage(envelope.data)} ${elapsed.toFixed(1)} ms`)}
        } else if (envelope.type === "control" && this.control !== null) {
            Atomics.store(this.control, 0, envelope.value)
        } else if (envelope.type === "capture") {
            const {uuid, deviceId, channels, gain, mode, volume, pan} = envelope
            const key = UUID.toString(uuid as UUID.Bytes)
            const peaks = this.captures.get(key)?.peaks ?? new Float32Array(channels)
            if (this.captures.get(key)?.deviceId !== deviceId) {input.requested = deviceId}
            const previous = this.captures.get(key)
            this.captures.set(key, {
                uuid, deviceId, channels, gain, mode, volume, pan, peaks: peaks.length === channels ? peaks : new Float32Array(channels),
                recording: previous?.recording ?? false, first: previous?.first ?? -1.0, planes: previous?.planes ?? []
            })
            refreshInput()
            this.updateMonitoringMap()
        } else if (envelope.type === "record") {
            const capture = this.captures.get(UUID.toString(envelope.uuid as UUID.Bytes))
            if (!isDefined(capture)) {return}
            if (!envelope.record) {this.flushRecording(capture)}
            capture.recording = envelope.record
            capture.first = -1.0
            capture.planes = []
        } else if (envelope.type === "capture-close") {
            this.captures.delete(UUID.toString(envelope.uuid as UUID.Bytes))
            refreshInput()
            this.updateMonitoringMap()
        } else if (envelope.type === "native-save") {
            NativePlugins.saveAll()
        } else if (envelope.type === "native-gui") {
            NativePlugins.openGui(envelope.uuid, envelope.open)
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

const refreshInput = (): void => {
    const wanted = Array.from(connections.values()).some(connection => connection.alive && connection.captures.size > 0)
    if (wanted) {__openInput(input.requested)} else {__closeInput()}
}

const sendInput = (connection: Connection): void => {
    const [name, channels] = input.info.length > 0 ? input.info.split("\t") : ["", "0"]
    connection.send({type: "input", name, channels: Number(channels)})
}

const parseDevices = (text: string): Array<{ name: string, channels: int }> => text.length === 0 ? []
    : text.split("\n").map(line => line.split("\t")).map(([name, channels]) => ({name, channels: Number(channels)}))

const announceInput = (): void => {
    const devices = __inputDevices()
    if (devices !== input.devices) {
        input.devices = devices
        connections.forEach(connection => connection.send({type: "input-devices", devices: parseDevices(devices)}))
    }
    const info = __inputInfo()
    if (info === input.info) {return}
    input.info = info
    connections.forEach(connection => {
        sendInput(connection)
        connection.updateMonitoringMap()
    })
}
const state = {quanta: 0}

const render = (out: Float32Array, buffer: Float32Array, channels: int): void => {
    if (input.buffer !== buffer) {
        input.buffer = buffer
        input.views = Array.from({length: 8}, (_, channel) => buffer.subarray(channel * RenderQuantum, (channel + 1) * RenderQuantum))
    }
    input.channels = channels
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
    if (++state.quanta % TickQuanta === 0) {
        connections.forEach(connection => connection.tick())
        announceInput()
    }
}

scope.__bridge = {
    open: (id: int): void => {
        const connection = new Connection(id)
        connections.set(id, connection)
        if (input.info.length > 0) {sendInput(connection)}
        connection.send({type: "input-devices", devices: parseDevices(input.devices)})
    },
    receive: (id: int, bytes: ArrayBuffer): void => connections.get(id)?.receive(bytes),
    close: (id: int): void => {
        connections.delete(id)
        refreshInput()
    },
    render
}
