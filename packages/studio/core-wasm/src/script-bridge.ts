// The SCRIPT BRIDGE: the JS side of the three scriptable devices (Werkstatt / Apparat / Spielwerk). Their Rust
// side-modules do no DSP — per block they call the `host_script_*` env imports defined here, which run the user
// `Processor` (registered by the app at `globalThis.openDAW.<registry>[uuid]`) over the engine's shared linear
// memory. So the SAME user JavaScript executes in the WASM engine as in the pure-TS engine; only the plumbing
// differs. This is the one place the engine's zero-JS-in-render rule is relaxed, and it is contained entirely
// here + in the three thin device crates. The bridge mirrors the TS `WerkstattDeviceProcessor` /
// `ApparatDeviceProcessor` / `SpielwerkDeviceProcessor`: hot-swap by the registry `update` counter, the same
// output validation (NaN / overflow -> silence), the SimpleLimiter (Apparat), and the param value mapping.
//
// Identity: the device's `init` calls `host_script_create(uuidPtr, kind, statePtr)` -> a handle; every later
// call passes that handle. Buffers are byte offsets into the ONE shared memory; we re-derive `memory.buffer`
// views EVERY call, since the SharedArrayBuffer can grow / detach (talc), never caching a typed-array view.

import {clamp, isDefined, Nullable, Provider, Terminable, tryCatch, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {LiveStreamBroadcaster} from "@opendaw/lib-fusion"
import {SimpleLimiter} from "@opendaw/lib-dsp"
import {copyEvents, runSpielwerk, SpielwerkRuntime} from "./script-spielwerk"

const RENDER_QUANTUM = 128
// ~1 second of render calls (128-frame quanta at 48k) before a scriptless device is reported — long enough to
// cover a script still compiling / addModule-ing async, short enough to surface a genuine misconfiguration.
const MISSING_GRACE_CALLS = 375
const STALE_UPDATE = -2

// Device kinds (mirror abi DEVICE_KIND_*) and their script registries.
const KIND_INSTRUMENT = 0
const KIND_AUDIO_EFFECT = 1
const KIND_MIDI_EFFECT = 2
const REGISTRY_BY_KIND: Record<number, string> = {
    [KIND_INSTRUMENT]: "apparatProcessors",
    [KIND_AUDIO_EFFECT]: "werkstattProcessors",
    [KIND_MIDI_EFFECT]: "spielwerkProcessors"
}

// Parameter wire kinds (mirror abi PARAM_KIND_*): UNIT is a 0..1 automation value to MAP; the rest are already
// the real (un-automated) field value, used directly.
const PARAM_KIND_UNIT = 0

const MAX_AMPLITUDE = 1000.0 // ~60 dB; matches the TS processors' validateOutput
const SIDECHAIN_PORT_BASE = 2 // WASM CONTRACT: a script device's sidechain port id = 2 + its `@sidechain` index
const DATA_RESET = 0xFFFFFFFF // WASM CONTRACT: `host_script_data` with this collection starts a new snapshot
const STREAM_KEY_BASE = 0x1000 // a `@stream` is broadcast at the device address + [0x1000 + its index]

type ParamDecl = {label: string, index: number, mapping: string, min: number, max: number, unit: string}
type SampleDecl = {label: string, index: number}
type SidechainDecl = {label: string, index: number}
type CollectionDecl = {name: string, index: number, fields: ReadonlyArray<{label: string, index: number, defaultValue: number}>}
type RawCollection = {records: number, fields: number, values: Float32Array}
type StreamDecl = {name: string, index: number, length: number, kind: "value" | "ring" | "fft"}
type RegistryEntry = {update: number, create: new () => any, params: ReadonlyArray<ParamDecl>, samples: ReadonlyArray<SampleDecl>,
    sidechains?: ReadonlyArray<SidechainDecl>, readsSidechains?: boolean, latency?: number, pass: boolean,
    collections?: ReadonlyArray<CollectionDecl>, streams?: ReadonlyArray<StreamDecl>}

// The minimal engine surface the bridge needs to resolve a sample's resident frames during render.
export interface ScriptEngine {
    host_resolve_sample(handle: number, outPtr: number): number
    host_resolve_input(id: number, outPtr: number): number
    input_reserve(length: number): number
}

// One scriptable device instance's JS-side state, keyed by the handle `host_script_create` returned.
class Bridge {
    proc: any = null
    currentUpdate = -1
    silenced = false
    // index -> {label, valueMapping}; built from the registry entry's parsed @param declarations.
    paramMappings = new Map<number, {label: string, mapping: ValueMapping<number>}>()
    // index -> the raw (kind, value) the engine last delivered. Cached so a value pushed BEFORE the proc loads
    // (the engine pushes initial / automated params at bind, before the first render builds the mappings) is
    // replayed once the proc + mappings exist, and re-mapped through the NEW mapping on a hot-swap.
    readonly rawParams = new Map<number, {kind: number, value: number, modulation: number}>()
    // index -> label, for @sample slots (Apparat); the resolved sample handle is cached so a hot-swap re-delivers.
    sampleLabels = new Map<number, string>()
    readonly sampleHandles = new Map<number, number>() // index -> resolved engine sample handle (-1 = no sample; 0 is valid)
    sidechains: ReadonlyArray<SidechainDecl> = []
    sidechainViews: Record<string, ReadonlyArray<Float32Array>> = {}
    sidechainLookup: Record<string, ReadonlyArray<Float32Array>> = {}
    readsSidechains = false
    declaredLatency = 0 // `// @latency <ms>`
    // `@collection` data: the engine delivers a snapshot (reset, then each present collection) off-render, it is
    // applied to `proc.data` before the next process call, so `dataChanged` never runs mid-transaction
    collections: ReadonlyArray<CollectionDecl> = []
    rawData = new Map<number, RawCollection>()
    pendingData: Nullable<Map<number, RawCollection>> = null
    // `@stream` packages of the CURRENT Processor, re-registered on every hot-swap
    streamSubscriptions: ReadonlyArray<Terminable> = []
    readonly sidechainSilence = new Map<number, ReadonlyArray<Float32Array>>()
    limiter: SimpleLimiter | null = null
    spielwerk: SpielwerkRuntime | null = null
    // Spielwerk's `@no-pass` verdict for the CURRENTLY loaded script. `true` by default so a device whose script
    // never loaded (or died) forwards its input instead of muting the chain.
    pass = true
    // A scriptable device with no registered Processor renders silence. That is legitimate for a block or two
    // while the script loads async, but a device that stays scriptless is an anomaly the host must surface (not
    // swallow). Count the render calls that found no registry entry; warn ONCE past the grace window.
    missingCalls = 0
    warnedMissing = false

    constructor(readonly handle: number, readonly uuid: string, readonly kind: number, readonly registryName: string,
                readonly key: string) {}
}

const resolveMapping = (declaration: ParamDecl): ValueMapping<number> => {
    // Mirrors ScriptDeclaration.resolveValueMapping EXACTLY (same lib-std calls), so the bridge maps a param's
    // automation value identically to the TS engine -> parity is by construction.
    switch (declaration.mapping) {
        case "unipolar": return ValueMapping.unipolar()
        case "linear": return ValueMapping.linear(declaration.min, declaration.max)
        case "exp": return ValueMapping.exponential(declaration.min, declaration.max)
        case "int": return ValueMapping.linearInteger(declaration.min, declaration.max) as ValueMapping<number>
        case "bool": return ValueMapping.linearInteger(0, 1) as ValueMapping<number>
        default: return ValueMapping.unipolar()
    }
}

const sameCollection = (left: Nullable<RawCollection> | undefined, right: Nullable<RawCollection> | undefined): boolean => {
    if (!isDefined(left) || !isDefined(right)) {return !isDefined(left) && !isDefined(right)}
    if (left.records !== right.records || left.fields !== right.fields) {return false}
    return left.values.every((value, index) => Object.is(value, right.values[index]))
}

// One frozen plain object per record, every declared field present (a missing value box is its `@field` default).
const toRecords = (collection: CollectionDecl, raw: Nullable<RawCollection> | undefined): ReadonlyArray<Readonly<Record<string, number>>> => {
    if (!isDefined(raw)) {return Object.freeze([])}
    return Object.freeze(Array.from({length: raw.records}, (unused, record) => Object.freeze(Object.fromEntries(
        collection.fields.map(({label, index, defaultValue}) => {
            const value = index < raw.fields ? raw.values[record * raw.fields + index] : NaN
            return [label, Number.isNaN(value) ? defaultValue : value]
        })))))
}

const SIDECHAIN_HINT = "this.sidechains is only available with a // @sidechain <name> declaration"

// Reading a name that no `@sidechain` line declares throws a named error instead of a bare TypeError.
const createSidechainLookup = (views: Record<string, ReadonlyArray<Float32Array>>,
                               declared: ReadonlyArray<SidechainDecl>): Record<string, ReadonlyArray<Float32Array>> => {
    const names = declared.map(({label}) => label).join(", ")
    return new Proxy(views, {
        get: (target, key) => {
            if (typeof key === "symbol" || Reflect.has(Object.prototype, key) || Object.hasOwn(target, key)) {
                return Reflect.get(target, key)
            }
            throw new Error(`No @sidechain '${key}' declared (declared: ${names})`)
        }
    })
}

const validateOutput = (channels: ReadonlyArray<Float32Array>, s0: number, s1: number): string | null => {
    for (let channel = 0; channel < channels.length; channel++) {
        const samples = channels[channel]
        for (let i = s0; i < s1; i++) {
            const sample = samples[i]
            if (sample !== sample) {return `NaN detected in output channel ${channel} at sample ${i}`}
            if (sample > MAX_AMPLITUDE || sample < -MAX_AMPLITUDE) {
                return `Signal overflow in channel ${channel} at sample ${i} (amplitude: ${sample.toFixed(1)})`
            }
        }
    }
    return null
}

export class ScriptBridges {
    readonly #memory: WebAssembly.Memory
    readonly #engine: ScriptEngine
    readonly #sampleRate: number
    readonly #onMessage: (uuid: string, message: string) => void
    readonly #bridges = new Map<number, Bridge>()
    // uuid + state pointer: a composite's replicas of one unit-level device share the box uuid but are separate
    // instances, each with its own Processor
    readonly #byInstance = new Map<string, number>()
    readonly #broadcaster: Provider<Nullable<LiveStreamBroadcaster>>
    // the bridge publishing a uuid's streams: composite replicas share the device address, the first one wins
    readonly #streamOwners = new Map<string, number>()
    #nextHandle = 1

    constructor(memory: WebAssembly.Memory, engine: ScriptEngine, sampleRate: number,
                onMessage: (uuid: string, message: string) => void = () => {},
                broadcaster: Provider<Nullable<LiveStreamBroadcaster>> = () => null) {
        this.#memory = memory
        this.#engine = engine
        this.#sampleRate = sampleRate
        this.#onMessage = onMessage
        this.#broadcaster = broadcaster
    }

    /// The `host_script_*` (+ no engine `host_self_uuid`) closures to bind into each scriptable device's `env`.
    imports(): Record<string, (...args: number[]) => number | void> {
        return {
            host_script_create: (uuidPtr, kind, statePtr) => this.#create(uuidPtr, kind, statePtr),
            host_script_audio: (handle, srcL, srcR, outL, outR, s0, s1, index, p0, p1, bpm, flags) =>
                this.#audio(handle, srcL, srcR, outL, outR, s0, s1, index, p0, p1, bpm, flags),
            host_script_note_on: (handle, pitch, velocity, cent, id) => this.#noteOn(handle, pitch, velocity, cent, id),
            host_script_note_off: (handle, id) => this.#noteOff(handle, id),
            host_script_reset: (handle) => this.#reset(handle),
            host_script_param: (handle, index, kind, value, modulation) =>
                this.#param(handle, index, kind, value, modulation),
            host_script_sample: (handle, index, sampleHandle, present) => this.#sample(handle, index, sampleHandle, present),
            host_script_notes: (handle, inPtr, inCount, outPtr, outMax, from, to, bpm, flags, s0, s1) =>
                this.#notes(handle, inPtr, inCount, outPtr, outMax, from, to, bpm, flags, s0, s1),
            host_script_release: (handle) => this.#release(handle),
            host_script_latency: (handle) => this.#latency(handle),
            host_script_data: (handle, collection, ptr, records, fields) => this.#data(handle, collection, ptr, records, fields)
        }
    }

    // A `create` for an instance that already has a live bridge REPLACES it: release the old one first (its
    // Processor + limiter + runtime), so a rebind the engine's `terminate` hasn't (yet, or ever) reached for
    // never orphans the previous bridge — the dedup a bare `#nextHandle++` per call was missing entirely.
    #create(uuidPtr: number, kind: number, statePtr: number): number {
        const uuid = UUID.toString(new Uint8Array(this.#memory.buffer, uuidPtr, 16).slice() as UUID.Bytes)
        const key = `${uuid}:${statePtr}`
        const existingHandle = this.#byInstance.get(key)
        if (isDefined(existingHandle)) {this.#release(existingHandle)}
        const handle = this.#nextHandle++
        this.#bridges.set(handle, new Bridge(handle, uuid, kind, REGISTRY_BY_KIND[kind] ?? "werkstattProcessors", key))
        this.#byInstance.set(key, handle)
        return handle
    }

    // Poll the registry and hot-swap the user Processor when its `update` changed (the TS #tryLoad/#swapProcessor),
    // then re-apply the cached params + samples. Returns the live, non-silenced proc, or null.
    #ensureProc(bridge: Bridge): any | null {
        const registry = (globalThis as any).openDAW?.[bridge.registryName]?.[bridge.uuid] as RegistryEntry | undefined
        if (registry === undefined && bridge.currentUpdate === -1) {
            // Never loaded and still absent: tolerate the async-load grace window, then report once so a scriptable
            // device silently muting its chain (the "Open Up renders silent" failure) can never pass unnoticed.
            if (!bridge.warnedMissing && ++bridge.missingCalls > MISSING_GRACE_CALLS) {
                bridge.warnedMissing = true
                this.#onMessage(bridge.uuid, `No Processor registered at globalThis.openDAW.${bridge.registryName}[${bridge.uuid}] — device is rendering silence`)
            }
            return null
        }
        if (registry !== undefined && registry.update !== bridge.currentUpdate) {
            // Outside the try: a script that throws in its constructor still gets ITS declared note routing.
            bridge.pass = registry.pass !== false
            try {
                const proc = new registry.create()
                bridge.paramMappings = new Map(registry.params.map(declaration => [declaration.index, {label: declaration.label, mapping: resolveMapping(declaration)}]))
                bridge.sampleLabels = new Map(registry.samples.map(declaration => [declaration.index, declaration.label]))
                bridge.sidechains = registry.sidechains ?? []
                bridge.sidechainViews = {}
                bridge.sidechainLookup = createSidechainLookup(bridge.sidechainViews, bridge.sidechains)
                bridge.readsSidechains = registry.readsSidechains === true
                bridge.declaredLatency = registry.latency ?? 0
                if (bridge.kind !== KIND_MIDI_EFFECT) {
                    proc.samples = {}
                    for (const label of bridge.sampleLabels.values()) {proc.samples[label] = null}
                }
                if (bridge.kind === KIND_INSTRUMENT) {
                    bridge.limiter ??= new SimpleLimiter(this.#sampleRate)
                }
                if (bridge.kind === KIND_MIDI_EFFECT) {
                    bridge.spielwerk = new SpielwerkRuntime()
                }
                bridge.proc = proc
                bridge.currentUpdate = registry.update
                bridge.silenced = false
                // Re-apply the parameters + samples the engine pushed before this swap (re-mapping each raw value
                // through the new script's @param mapping).
                for (const [index, raw] of bridge.rawParams) {this.#applyParam(bridge, index, raw.kind, raw.value, raw.modulation)}
                for (const [index, sampleHandle] of bridge.sampleHandles) {this.#deliverSample(bridge, index, sampleHandle)}
                bridge.collections = registry.collections ?? []
                this.#syncData(bridge, true)
                this.#bindStreams(bridge, proc, registry.streams ?? [])
            } catch (error) {
                this.#silence(bridge, `Failed to instantiate Processor: ${error}`)
            }
        }
        return bridge.silenced ? null : bridge.proc
    }

    // a script declares its delay with `// @latency <ms>`, or changes it at runtime with `this.latency = frames`
    #latency(handle: number): number {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return 0}
        const latency: unknown = bridge.proc?.latency
        if (typeof latency === "number" && Number.isFinite(latency) && latency > 0) {return Math.round(latency)}
        return Math.round(bridge.declaredLatency * this.#sampleRate / 1000)
    }

    #audio(handle: number, srcL: number, srcR: number, outL: number, outR: number,
           s0: number, s1: number, index: number, p0: number, p1: number, bpm: number, flags: number): number {
        const buffer = this.#memory.buffer
        const outLeft = new Float32Array(buffer, outL, RENDER_QUANTUM)
        const outRight = new Float32Array(buffer, outR, RENDER_QUANTUM)
        // the engine keeps a device's output between quanta: every failure must clear it, or the last quantum loops
        const mute = (): number => {
            outLeft.fill(0.0, s0, s1)
            outRight.fill(0.0, s0, s1)
            return 1
        }
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return mute()}
        const proc = this.#ensureProc(bridge)
        if (proc === null) {return mute()}
        const block = {index, p0, p1, s0, s1, bpm, flags}
        if (!this.#syncData(bridge, false)) {return mute()}
        try {
            if (bridge.sidechains.length > 0) {
                this.#deliverSidechains(bridge, s0, s1)
                proc.sidechains = bridge.sidechainLookup
            }
            // Re-resolve the @sample slots every block (mirrors the TS `#pollSamples`): a sample's PCM loads
            // ASYNC after bind, so the handle is delivered before its frames are resident; re-resolving flips
            // `samples[label]` from null to the AudioData once ready. Re-deriving the views each block also
            // keeps them valid if the SharedArrayBuffer grew (same reason `#audio` re-derives its outputs).
            for (const [sampleIndex, sampleHandle] of bridge.sampleHandles) {this.#deliverSample(bridge, sampleIndex, sampleHandle)}
            if (bridge.kind === KIND_AUDIO_EFFECT) {
                const io = {src: [new Float32Array(buffer, srcL, RENDER_QUANTUM), new Float32Array(buffer, srcR, RENDER_QUANTUM)], out: [outLeft, outRight]}
                proc.process(io, block)
            } else {
                outLeft.fill(0.0, s0, s1)
                outRight.fill(0.0, s0, s1)
                proc.process([outLeft, outRight], block)
            }
        } catch (error) {
            const hint = error instanceof TypeError && bridge.readsSidechains && bridge.sidechains.length === 0
                && proc.sidechains === undefined ? ` (${SIDECHAIN_HINT})` : ""
            this.#silence(bridge, `Runtime error: ${error}${hint}`)
            return mute()
        }
        const error = validateOutput([outLeft, outRight], s0, s1)
        if (error !== null) {
            this.#silence(bridge, error)
            return mute()
        }
        if (bridge.kind === KIND_INSTRUMENT && bridge.limiter !== null) {
            // SimpleLimiter.replace only reads `buffer.channels()`; a duck-typed view over our two channels reuses
            // the exact limiter code (and its persistent envelope) without an intermediate AudioBuffer copy.
            bridge.limiter.replace({channels: () => [outLeft, outRight]} as any, s0, s1)
        }
        return 0
    }

    // Notes can arrive BEFORE the first audio block, so ensure the user Processor is loaded here too (the engine
    // delivers note-on/off, then calls process; the TS processor has the proc loaded before any note).
    #noteOn(handle: number, pitch: number, velocity: number, cent: number, id: number): void {
        const bridge = this.#bridges.get(handle)
        if (bridge !== undefined) {this.#ensureProc(bridge)?.noteOn?.(pitch, velocity, cent, id)}
    }

    #noteOff(handle: number, id: number): void {
        const bridge = this.#bridges.get(handle)
        if (bridge !== undefined) {this.#ensureProc(bridge)?.noteOff?.(id)}
    }

    #reset(handle: number): void {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return}
        if (bridge.kind === KIND_AUDIO_EFFECT && !bridge.silenced && typeof bridge.proc?.reset !== "function") {
            bridge.currentUpdate = STALE_UPDATE // no reset() in the script: the next pull rebuilds the Processor
        } else {
            bridge.proc?.reset?.()
        }
        bridge.spielwerk?.reset()
    }

    #param(handle: number, index: number, kind: number, value: number, modulation: number): void {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return}
        bridge.rawParams.set(index, {kind, value, modulation}) // cache for replay once the proc + mappings exist
        this.#applyParam(bridge, index, kind, value, modulation)
    }

    // Map one raw (kind, value) through the param's @param mapping and hand it to the user proc. A no-op when the
    // proc / mappings are not loaded yet — `#ensureProc` replays `rawParams` once they are. The script's mapping
    // lives here, so this is where a modulation sum (NaN = none) folds in, like the Rust `float_value`.
    #applyParam(bridge: Bridge, index: number, kind: number, value: number, modulation: number): void {
        const entry = bridge.paramMappings.get(index)
        if (entry === undefined) {return}
        if (isNaN(modulation)) {
            bridge.proc?.paramChanged?.(entry.label, kind === PARAM_KIND_UNIT ? entry.mapping.y(value) : value)
            return
        }
        const unit = kind === PARAM_KIND_UNIT ? value : entry.mapping.x(value)
        bridge.proc?.paramChanged?.(entry.label, entry.mapping.y(clamp(unit + modulation, 0.0, 1.0)))
    }

    // The engine's sample handles are 0-based slot indices, so 0 is a VALID handle; `present` is the absence
    // signal. Cache -1 when no sample so `#deliverSample` can tell "handle 0, resolved" from "no sample".
    #sample(handle: number, index: number, sampleHandle: number, present: number): void {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return}
        const resolved = present !== 0 ? sampleHandle : -1
        bridge.sampleHandles.set(index, resolved)
        this.#deliverSample(bridge, index, resolved)
    }

    #notes(handle: number, inPtr: number, inCount: number, outPtr: number, outMax: number,
           from: number, to: number, bpm: number, flags: number, s0: number, s1: number): number {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return 0}
        // No live Processor (never loaded, or silenced): forward the input, so a scriptless / broken Spielwerk
        // is transparent rather than a mute button. A `@no-pass` script keeps its silence, as its author asked.
        const forward = (): number => bridge.pass ? copyEvents(this.#memory.buffer, inPtr, inCount, outPtr, outMax) : 0
        const proc = this.#ensureProc(bridge)
        if (proc === null || bridge.spielwerk === null || !this.#syncData(bridge, false)) {return forward()}
        try {
            return runSpielwerk(bridge.spielwerk, proc, this.#memory.buffer, inPtr, inCount, outPtr, outMax, from, to, bpm, flags, s0, s1, bridge.pass)
        } catch (error) {
            this.#silence(bridge, `Runtime error: ${error}`)
            return forward()
        }
    }

    #data(handle: number, collection: number, ptr: number, records: number, fields: number): void {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return}
        if (collection === DATA_RESET) {
            bridge.pendingData = new Map()
            return
        }
        const values = new Float32Array(this.#memory.buffer, ptr, records * fields).slice()
        bridge.pendingData ??= new Map()
        bridge.pendingData.set(collection, {records, fields, values})
    }

    // Apply a pending snapshot (or, with `force`, the current one after a hot-swap) to `proc.data` and call
    // `dataChanged(name)` for every collection whose values changed. A script without `@collection` never
    // gets a `data` property. Returns false when `dataChanged` threw and silenced the device.
    #syncData(bridge: Bridge, force: boolean): boolean {
        const proc = bridge.proc
        if (proc === null || bridge.collections.length === 0) {
            if (bridge.pendingData !== null) {
                bridge.rawData = bridge.pendingData
                bridge.pendingData = null
            }
            return true
        }
        const pending = bridge.pendingData
        if (pending === null && !force) {return true}
        const next = pending ?? bridge.rawData
        const changed = bridge.collections.filter(({index}) => force || !sameCollection(bridge.rawData.get(index), next.get(index)))
        bridge.rawData = next
        bridge.pendingData = null
        proc.data = Object.freeze(Object.fromEntries(bridge.collections.map(collection =>
            [collection.name, toRecords(collection, next.get(collection.index))])))
        const result = tryCatch(() => changed.forEach(({name}) => proc.dataChanged?.(name)))
        if (result.status === "failure") {
            this.#silence(bridge, `Runtime error in dataChanged: ${result.error}`)
            return false
        }
        return true
    }

    // Resolve a sample handle's resident planar frames and hand the user proc an AudioData view (no copy).
    #deliverSample(bridge: Bridge, index: number, sampleHandle: number): void {
        if (bridge.proc === null) {return}
        const label = bridge.sampleLabels.get(index)
        if (label === undefined) {return}
        if (sampleHandle < 0) {bridge.proc.samples[label] = null; return}
        const scratch = this.#engine.input_reserve(16)
        if (this.#engine.host_resolve_sample(sampleHandle, scratch) === 0) {bridge.proc.samples[label] = null; return}
        const view = new DataView(this.#memory.buffer, scratch, 16)
        const framesPtr = view.getUint32(0, true)
        const frameCount = view.getUint32(4, true)
        const channelCount = view.getUint32(8, true)
        const sampleRate = view.getFloat32(12, true)
        const frames: Float32Array[] = []
        for (let channel = 0; channel < channelCount; channel++) {
            frames.push(new Float32Array(this.#memory.buffer, framesPtr + channel * frameCount * 4, frameCount))
        }
        bridge.proc.samples[label] = {sampleRate, numberOfFrames: frameCount, numberOfChannels: channelCount, frames}
    }

    // Runs inside the device's `process`, while the engine has its resolved sidechain ports swapped in.
    #deliverSidechains(bridge: Bridge, s0: number, s1: number): void {
        const scratch = this.#engine.input_reserve(16)
        for (const {label, index} of bridge.sidechains) {
            if (this.#engine.host_resolve_input(SIDECHAIN_PORT_BASE + index, scratch) === 0) {
                let silence = bridge.sidechainSilence.get(index)
                if (silence === undefined) {
                    silence = [new Float32Array(RENDER_QUANTUM), new Float32Array(RENDER_QUANTUM)]
                    bridge.sidechainSilence.set(index, silence)
                }
                silence.forEach(channel => channel.fill(0.0, s0, s1))
                bridge.sidechainViews[label] = silence
            } else {
                const buffer = this.#memory.buffer
                const view = new DataView(buffer, scratch, 8)
                bridge.sidechainViews[label] = [
                    new Float32Array(buffer, view.getUint32(0, true), RENDER_QUANTUM),
                    new Float32Array(buffer, view.getUint32(4, true), RENDER_QUANTUM)]
            }
        }
    }

    // `this.streams.<name>`: a value stream is a Float32Array the processor overwrites, a ring / fft stream takes
    // `write(channel, s0, s1)` and publishes its latest samples in order. `.active` tells whether a view listens.
    #bindStreams(bridge: Bridge, proc: any, streams: ReadonlyArray<StreamDecl>): void {
        this.#unbindStreams(bridge)
        if (streams.length === 0) {return}
        const owner = this.#streamOwners.get(bridge.uuid)
        const publisher = !isDefined(owner) || owner === bridge.handle ? this.#broadcaster() : null
        if (isDefined(publisher)) {this.#streamOwners.set(bridge.uuid, bridge.handle)}
        const uuid = UUID.parse(bridge.uuid)
        const subscriptions: Array<Terminable> = []
        proc.streams = Object.freeze(Object.fromEntries(streams.map(({name, index, length, kind}) => {
            const state = {active: false}
            const address = Address.compose(uuid, STREAM_KEY_BASE + index)
            if (kind === "value") {
                const values = new Float32Array(length)
                Object.defineProperty(values, "active", {get: () => state.active})
                if (isDefined(publisher)) {
                    subscriptions.push(publisher.broadcastFloats(address, values, active => {state.active = active}))
                }
                return [name, values]
            }
            const size = kind === "fft" ? length * 2 : length
            const ring = new Float32Array(size)
            const published = new Float32Array(size)
            const cursor = {index: 0}
            if (isDefined(publisher)) {
                subscriptions.push(publisher.broadcastFloats(address, published, active => {
                    state.active = active
                    if (!active) {return}
                    published.set(ring.subarray(cursor.index), 0)
                    published.set(ring.subarray(0, cursor.index), size - cursor.index)
                }))
            }
            return [name, Object.freeze({
                get active() {return state.active},
                write(channel: Float32Array, from: number = 0, to: number = channel.length) {
                    for (let position = from; position < to; position++) {
                        ring[cursor.index] = channel[position]
                        cursor.index = cursor.index + 1 === size ? 0 : cursor.index + 1
                    }
                }
            })]
        })))
        bridge.streamSubscriptions = subscriptions
    }

    #unbindStreams(bridge: Bridge): void {
        bridge.streamSubscriptions.forEach(subscription => subscription.terminate())
        bridge.streamSubscriptions = []
        if (this.#streamOwners.get(bridge.uuid) === bridge.handle) {this.#streamOwners.delete(bridge.uuid)}
    }

    #silence(bridge: Bridge, message: string): void {
        bridge.silenced = true
        this.#onMessage(bridge.uuid, message)
    }

    // THIS device's instance is dying (a genuine removal, never a chain-edit survivor, called from the
    // engine's `terminate` export — or a `#create` dedup replacing a stale bridge for the same uuid): drop
    // the bridge (its Processor + limiter + runtime are then just garbage-collected JS objects).
    #release(handle: number): void {
        const bridge = this.#bridges.get(handle)
        if (!isDefined(bridge)) {return}
        this.#unbindStreams(bridge)
        this.#bridges.delete(handle)
        if (this.#byInstance.get(bridge.key) === handle) {this.#byInstance.delete(bridge.key)}
    }

    /// Test-only introspection: how many bridges are currently live, proving a rebind's `#create` dedup
    /// released the previous one instead of orphaning it.
    liveBridgeCount(): number {
        return this.#bridges.size
    }
}
