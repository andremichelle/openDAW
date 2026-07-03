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

import {UUID, ValueMapping} from "@opendaw/lib-std"
import {SimpleLimiter} from "@opendaw/lib-dsp"
import {runSpielwerk, SpielwerkRuntime} from "./script-spielwerk"

const RENDER_QUANTUM = 128
// ~1 second of render calls (128-frame quanta at 48k) before a scriptless device is reported — long enough to
// cover a script still compiling / addModule-ing async, short enough to surface a genuine misconfiguration.
const MISSING_GRACE_CALLS = 375

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

type ParamDecl = {label: string, index: number, mapping: string, min: number, max: number, unit: string}
type SampleDecl = {label: string, index: number}
type RegistryEntry = {update: number, create: new () => any, params: ReadonlyArray<ParamDecl>, samples: ReadonlyArray<SampleDecl>}

// The minimal engine surface the bridge needs to resolve a sample's resident frames during render.
export interface ScriptEngine {
    host_resolve_sample(handle: number, outPtr: number): number
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
    readonly rawParams = new Map<number, {kind: number, value: number}>()
    // index -> label, for @sample slots (Apparat); the resolved sample handle is cached so a hot-swap re-delivers.
    sampleLabels = new Map<number, string>()
    readonly sampleHandles = new Map<number, number>() // index -> resolved engine sample handle (-1 = no sample; 0 is valid)
    limiter: SimpleLimiter | null = null
    spielwerk: SpielwerkRuntime | null = null
    // A scriptable device with no registered Processor renders silence. That is legitimate for a block or two
    // while the script loads async, but a device that stays scriptless is an anomaly the host must surface (not
    // swallow). Count the render calls that found no registry entry; warn ONCE past the grace window.
    missingCalls = 0
    warnedMissing = false

    constructor(readonly uuid: string, readonly kind: number, readonly registryName: string) {}
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
    #nextHandle = 1

    constructor(memory: WebAssembly.Memory, engine: ScriptEngine, sampleRate: number,
                onMessage: (uuid: string, message: string) => void = () => {}) {
        this.#memory = memory
        this.#engine = engine
        this.#sampleRate = sampleRate
        this.#onMessage = onMessage
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
            host_script_param: (handle, index, kind, value) => this.#param(handle, index, kind, value),
            host_script_sample: (handle, index, sampleHandle, present) => this.#sample(handle, index, sampleHandle, present),
            host_script_notes: (handle, inPtr, inCount, outPtr, outMax, from, to, bpm, flags, s0, s1) =>
                this.#notes(handle, inPtr, inCount, outPtr, outMax, from, to, bpm, flags, s0, s1)
        }
    }

    #create(uuidPtr: number, kind: number, _statePtr: number): number {
        const uuid = UUID.toString(new Uint8Array(this.#memory.buffer, uuidPtr, 16).slice() as UUID.Bytes)
        const handle = this.#nextHandle++
        this.#bridges.set(handle, new Bridge(uuid, kind, REGISTRY_BY_KIND[kind] ?? "werkstattProcessors"))
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
            try {
                const proc = new registry.create()
                bridge.paramMappings = new Map(registry.params.map(declaration => [declaration.index, {label: declaration.label, mapping: resolveMapping(declaration)}]))
                bridge.sampleLabels = new Map(registry.samples.map(declaration => [declaration.index, declaration.label]))
                if (bridge.kind === KIND_INSTRUMENT) {
                    proc.samples = {}
                    for (const label of bridge.sampleLabels.values()) {proc.samples[label] = null}
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
                for (const [index, raw] of bridge.rawParams) {this.#applyParam(bridge, index, raw.kind, raw.value)}
                for (const [index, sampleHandle] of bridge.sampleHandles) {this.#deliverSample(bridge, index, sampleHandle)}
            } catch (error) {
                this.#silence(bridge, `Failed to instantiate Processor: ${error}`)
            }
        }
        return bridge.silenced ? null : bridge.proc
    }

    #audio(handle: number, srcL: number, srcR: number, outL: number, outR: number,
           s0: number, s1: number, index: number, p0: number, p1: number, bpm: number, flags: number): number {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return 1}
        const proc = this.#ensureProc(bridge)
        if (proc === null) {return 1}
        const buffer = this.#memory.buffer
        const outLeft = new Float32Array(buffer, outL, RENDER_QUANTUM)
        const outRight = new Float32Array(buffer, outR, RENDER_QUANTUM)
        const block = {index, p0, p1, s0, s1, bpm, flags}
        try {
            if (bridge.kind === KIND_AUDIO_EFFECT) {
                const io = {src: [new Float32Array(buffer, srcL, RENDER_QUANTUM), new Float32Array(buffer, srcR, RENDER_QUANTUM)], out: [outLeft, outRight]}
                proc.process(io, block)
            } else {
                // Re-resolve the @sample slots every block (mirrors the TS `#pollSamples`): a sample's PCM loads
                // ASYNC after bind, so the handle is delivered before its frames are resident; re-resolving flips
                // `samples[label]` from null to the AudioData once ready. Re-deriving the views each block also
                // keeps them valid if the SharedArrayBuffer grew (same reason `#audio` re-derives its outputs).
                for (const [sampleIndex, sampleHandle] of bridge.sampleHandles) {this.#deliverSample(bridge, sampleIndex, sampleHandle)}
                outLeft.fill(0.0, s0, s1)
                outRight.fill(0.0, s0, s1)
                proc.process([outLeft, outRight], block)
            }
        } catch (error) {
            this.#silence(bridge, `Runtime error: ${error}`)
            return 1
        }
        const error = validateOutput([outLeft, outRight], s0, s1)
        if (error !== null) {
            outLeft.fill(0.0, s0, s1)
            outRight.fill(0.0, s0, s1)
            this.#silence(bridge, error)
            return 1
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
        bridge?.proc?.reset?.()
        bridge?.spielwerk?.reset()
    }

    #param(handle: number, index: number, kind: number, value: number): void {
        const bridge = this.#bridges.get(handle)
        if (bridge === undefined) {return}
        bridge.rawParams.set(index, {kind, value}) // cache for replay once the proc + mappings exist
        this.#applyParam(bridge, index, kind, value)
    }

    // Map one raw (kind, value) through the param's @param mapping and hand it to the user proc. A no-op when the
    // proc / mappings are not loaded yet — `#ensureProc` replays `rawParams` once they are.
    #applyParam(bridge: Bridge, index: number, kind: number, value: number): void {
        const entry = bridge.paramMappings.get(index)
        if (entry === undefined) {return}
        const mapped = kind === PARAM_KIND_UNIT ? entry.mapping.y(value) : value
        bridge.proc?.paramChanged?.(entry.label, mapped)
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
        const proc = this.#ensureProc(bridge)
        if (proc === null || bridge.spielwerk === null) {return 0}
        try {
            return runSpielwerk(bridge.spielwerk, proc, this.#memory.buffer, inPtr, inCount, outPtr, outMax, from, to, bpm, flags, s0, s1)
        } catch (error) {
            this.#silence(bridge, `Runtime error: ${error}`)
            return 0
        }
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

    #silence(bridge: Bridge, message: string): void {
        bridge.silenced = true
        this.#onMessage(bridge.uuid, message)
    }
}
