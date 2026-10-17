// The offline render host, shipped in the desktop web build as offline-host.js: the engine process runs it on a
// thread of its own, next to the unchanged wasm-offline-worker bundle, one isolate per render
import {int, isDefined, Nullable, Optional, Procedure} from "@opendaw/lib-std"
import {BridgeShared, LiveLock, SyncState, ToEngine, ToStudio} from "../bridge/BridgeLink"
import type {EngineModules} from "../../../../../../studio/core-wasm/src/engine-modules"
import {NativePlugins} from "./NativePlugins"

declare const __offlineSend: (bytes: ArrayBuffer) => void

type Scope = Record<string, unknown>
type Modules = EngineModules & { hostImports?: typeof NativePlugins.imports }
type Call = { message?: { func?: string, args?: Array<{ value?: { syncStreamBuffer?: SharedArrayBuffer } }> } }

const scope = globalThis as unknown as Scope

const send = (envelope: ToStudio): void => __offlineSend(shared.encode(envelope))

// stands in for a studio MessagePort: what the worker posts goes back to the studio's port
class RelayPort {
    onmessage: Nullable<Procedure<MessageEvent>> = null
    onmessageerror: Nullable<Procedure<MessageEvent>> = null
    constructor(readonly id: int) {}
    postMessage(data: unknown): void {send({type: "port", id: this.id, data})}
    start(): void {}
    close(): void {}
}

const ports = new Map<int, RelayPort>()
const inFlight = new Set<int>()
const sync: { id: Optional<int>, view: Nullable<Uint8Array> } = {id: undefined, view: null}

const shared = new BridgeShared("engine", {
    idOfPort: (): int => {throw new Error("ports do not travel to the studio")},
    portOf: (id: int): unknown => {
        const known = ports.get(id)
        if (isDefined(known)) {return known}
        const port = new RelayPort(id)
        ports.set(id, port)
        return port
    }
})

scope.MessagePort = RelayPort
scope.onmessage = null
scope.onmessageerror = null
scope.postMessage = (data: unknown): void => send({type: "message", data})

// the render plays native plugins like the realtime engine, each through a copy of its own
scope.extendEngineModules = async (modules: Modules, base: string): Promise<Modules> => {
    const nativeModules = await NativePlugins.deviceModules(base).catch(error => {
        console.warn("[offline] no native plugin device", error)
        return null
    })
    return nativeModules === null ? modules : {
        ...modules, hostImports: NativePlugins.imports,
        deviceModules: [...modules.deviceModules, ...nativeModules.modules], deviceBoxTypes: [...modules.deviceBoxTypes, ...nativeModules.boxTypes]
    }
}

// the engine state stream is the one the studio hands over with `initialize`
const watchInitialize = (data: unknown): void => {
    const {message} = data as Call
    if (message?.func !== "initialize") {return}
    const buffer = message.args?.[1]?.value?.syncStreamBuffer
    if (!isDefined(buffer)) {return}
    sync.id = shared.idOf(buffer)
    sync.view = new Uint8Array(buffer)
}

scope.__offline = {
    receive: (bytes: ArrayBuffer): void => {
        const envelope = shared.decode<ToEngine>(bytes)
        if (envelope.type === "message") {
            watchInitialize(envelope.data)
            const onmessage = scope.onmessage as Nullable<Procedure<MessageEvent>>
            onmessage?.({data: envelope.data} as MessageEvent)
        } else if (envelope.type === "port") {
            ports.get(envelope.id)?.onmessage?.({data: envelope.data} as MessageEvent)
        } else if (envelope.type === "live-return") {
            const data = shared.get(envelope.data)
            const lock = shared.get(envelope.lock)
            inFlight.delete(envelope.lock)
            if (!isDefined(data) || !isDefined(lock)) {return}
            new Uint8Array(data).set(envelope.bytes)
            Atomics.store(new Int8Array(lock), 0, LiveLock.WRITE)
        }
    },
    tick: (): void => {
        if (isDefined(sync.id) && sync.view !== null && Atomics.load(sync.view, 0) === SyncState.WRITTEN) {
            send({type: "sync", id: sync.id, bytes: sync.view.slice(1)})
            Atomics.store(sync.view, 0, SyncState.READ)
        }
        const own = shared.own()
        const data = own.filter(([, buffer]) => buffer.byteLength > 1).at(-1)
        if (!isDefined(data)) {return}
        own.filter(([, buffer]) => buffer.byteLength === 1).forEach(([lockId, lock]) => {
            if (inFlight.has(lockId) || Atomics.load(new Int8Array(lock), 0) !== LiveLock.READ) {return}
            inFlight.add(lockId)
            send({type: "live", lock: lockId, data: data[0], bytes: new Uint8Array(data[1]).slice()})
        })
    }
}
