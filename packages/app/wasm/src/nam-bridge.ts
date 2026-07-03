// The NAM BRIDGE: the JS side of the NeuralAmp device. Its Rust side-module does the wrapper DSP (gains,
// mono downmix, dry/wet mix) and calls the `host_nam_*` env imports defined here, which run the SAME
// `@opendaw/nam-wasm` module (NeuralAmpModelerCore, A2-capable) the TS engine's `NeuralAmpDeviceProcessor`
// runs — instantiated as its OWN wasm instance next to the engine (an Emscripten build cannot join the
// engine's shared memory). Per chunk the bridge copies ≤128 samples per channel between the two memories,
// negligible next to the inference. Like the SCRIPT BRIDGE, this is a contained relaxation of the engine's
// zero-JS-in-render rule.
//
// Identity: the device's `init` calls `host_nam_create(uuidPtr)` -> a handle KEYED BY THE DEVICE BOX UUID, so
// a rebind reuses the existing instances and their loaded (prewarmed) model. The model JSON arrives as raw
// UTF-8 bytes out of the ENGINE's memory (`observe_target_string` on the device's model pointer) and is
// copied straight into the nam heap — no JS string, no TextDecoder (the worklet scope has none).
// Byte-identical deliveries (rebind catch-ups) are skipped. The nam module itself loads LAZILY on the first
// model delivery; until it is ready `host_nam_process` reports not-loaded and the device passes through,
// mirroring the TS processor while its wasm fetch is in flight.

import {isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {createNamModule, EmscriptenModule, NamWasmModule} from "@opendaw/nam-wasm"

// One NeuralAmp device's JS-side state, keyed by the handle `host_nam_create` returned. `instances` mirrors
// the TS processor's `#instances: [int, int]` (mono uses only the first; -1 = none).
class Bridge {
    readonly instances: [number, number] = [-1, -1]
    json: Nullable<Uint8Array> = null // the cached model bytes; null = no model (unloaded)
    loaded = false
    mono = true

    constructor(readonly uuid: string) {}
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) {return false}
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) {return false}
    }
    return true
}

export class NamBridges {
    readonly #memory: WebAssembly.Memory
    readonly #fetchWasm: () => Promise<ArrayBuffer>
    readonly #sampleRate: number
    readonly #bridges = new Map<number, Bridge>()
    readonly #byUuid = new Map<string, number>()
    #nextHandle = 1
    #emscripten: Nullable<EmscriptenModule> = null
    #module: Nullable<NamWasmModule> = null
    #loading = false
    #failed = false

    constructor(memory: WebAssembly.Memory, fetchWasm: () => Promise<ArrayBuffer>, sampleRate: number) {
        this.#memory = memory
        this.#fetchWasm = fetchWasm
        this.#sampleRate = sampleRate
    }

    /// Resolves once no module fetch/instantiation is in flight (models are applied synchronously when it
    /// lands). For tests: after a bind delivered a model, `await settle()` guarantees `host_nam_process` stops
    /// reporting not-loaded (or the load genuinely failed).
    async settle(): Promise<void> {
        while (this.#loading) {await new Promise(resolve => setTimeout(resolve, 1))}
    }

    /// The `host_nam_*` closures to bind into each device's `env`.
    imports(): Record<string, (...args: Array<number>) => number | void> {
        return {
            host_nam_create: (uuidPtr) => this.#create(uuidPtr),
            host_nam_load: (handle, jsonPtr, jsonLen) => this.#load(handle, jsonPtr, jsonLen),
            host_nam_set_mono: (handle, mono) => this.#setMono(handle, mono !== 0),
            host_nam_process: (handle, in0, in1, out0, out1, frames, channels) =>
                this.#process(handle, in0, in1, out0, out1, frames, channels),
            host_nam_reset: (handle) => this.#reset(handle)
        }
    }

    #create(uuidPtr: number): number {
        const uuid = UUID.toString(new Uint8Array(this.#memory.buffer, uuidPtr, 16).slice() as UUID.Bytes)
        const existing = this.#byUuid.get(uuid)
        if (isDefined(existing)) {return existing}
        const handle = this.#nextHandle++
        this.#bridges.set(handle, new Bridge(uuid))
        this.#byUuid.set(uuid, handle)
        return handle
    }

    // The model delivery: copy the JSON bytes out of the engine memory SYNCHRONOUSLY (they borrow the box
    // graph only for this call), dedupe against the cached bytes, and load / unload the instances. Kicks the
    // lazy module fetch on the first real model.
    #load(handle: number, jsonPtr: number, jsonLen: number): void {
        const bridge = this.#bridges.get(handle)
        if (!isDefined(bridge)) {return}
        if (jsonLen === 0) {
            bridge.json = null
            this.#unloadInstances(bridge)
            return
        }
        const json = new Uint8Array(this.#memory.buffer, jsonPtr, jsonLen).slice()
        if (isDefined(bridge.json) && bytesEqual(bridge.json, json)) {return}
        bridge.json = json
        if (isDefined(this.#module)) {
            this.#applyModel(bridge)
        } else {
            this.#ensureModule()
        }
    }

    // Mirror the TS `#onMonoChanged`: mono drops the second instance; stereo creates it and loads the cached
    // model into it.
    #setMono(handle: number, mono: boolean): void {
        const bridge = this.#bridges.get(handle)
        if (!isDefined(bridge)) {return}
        bridge.mono = mono
        const module = this.#module
        if (!isDefined(module)) {return}
        if (mono) {
            if (bridge.instances[1] >= 0) {
                module.unloadModel(bridge.instances[1])
                module.destroyInstance(bridge.instances[1])
                bridge.instances[1] = -1
            }
        } else if (bridge.instances[1] < 0) {
            bridge.instances[1] = module.createInstance()
            if (isDefined(bridge.json) && bridge.loaded) {
                bridge.loaded = this.#loadInto(bridge.instances[1], bridge.json) && bridge.loaded
            }
        }
    }

    // One chunk of both channels: Float32Array views over the ENGINE memory (re-derived every call — the
    // SharedArrayBuffer can grow), copied through the nam heap by `NamWasmModule.process`. Returns 1 only when
    // the model is loaded; 0 is the device's passthrough cue (module still loading / no model / unknown handle).
    #process(handle: number, in0: number, in1: number, out0: number, out1: number,
             frames: number, channels: number): number {
        const bridge = this.#bridges.get(handle)
        const module = this.#module
        if (!isDefined(bridge) || !isDefined(module) || !bridge.loaded || bridge.instances[0] < 0) {return 0}
        const buffer = this.#memory.buffer
        module.process(bridge.instances[0], new Float32Array(buffer, in0, frames), new Float32Array(buffer, out0, frames))
        if (channels > 1) {
            if (bridge.instances[1] < 0) {return 0}
            module.process(bridge.instances[1], new Float32Array(buffer, in1, frames), new Float32Array(buffer, out1, frames))
        }
        return 1
    }

    #reset(handle: number): void {
        const bridge = this.#bridges.get(handle)
        const module = this.#module
        if (!isDefined(bridge) || !isDefined(module)) {return}
        for (const instance of bridge.instances) {
            if (instance >= 0) {module.reset(instance)}
        }
    }

    // Fetch + instantiate the nam module ONCE (lazily, off the render path), then apply every bridge's pending
    // model. A failure logs and stays failed: every device keeps passing through, the TS engine's behavior.
    #ensureModule(): void {
        if (this.#loading || this.#failed || isDefined(this.#module)) {return}
        this.#loading = true
        this.#fetchWasm()
            .then(wasmBinary => createNamModule({wasmBinary, locateFile: () => ""}))
            .then(emscripten => {
                this.#emscripten = emscripten
                const module = NamWasmModule.fromModule(emscripten)
                module.setSampleRate(this.#sampleRate)
                this.#module = module
                this.#loading = false
                for (const bridge of this.#bridges.values()) {
                    if (isDefined(bridge.json)) {this.#applyModel(bridge)}
                }
            })
            .catch(error => {
                this.#loading = false
                this.#failed = true
                console.error("Failed to load NAM WASM:", error)
            })
    }

    // Mirror the TS `#applyModel`: ensure the instances match the mono flag, then load the cached JSON into
    // each. `loaded` gates `#process`, so a failed load keeps the device passing through.
    #applyModel(bridge: Bridge): void {
        const module = this.#module
        if (!isDefined(module) || !isDefined(bridge.json)) {return}
        if (bridge.instances[0] < 0) {bridge.instances[0] = module.createInstance()}
        if (!bridge.mono && bridge.instances[1] < 0) {bridge.instances[1] = module.createInstance()}
        bridge.loaded = this.#loadInto(bridge.instances[0], bridge.json)
        if (bridge.instances[1] >= 0) {
            bridge.loaded = this.#loadInto(bridge.instances[1], bridge.json) && bridge.loaded
        }
    }

    #unloadInstances(bridge: Bridge): void {
        bridge.loaded = false
        const module = this.#module
        if (!isDefined(module)) {return}
        for (const instance of bridge.instances) {
            if (instance >= 0) {module.unloadModel(instance)}
        }
    }

    // Load raw model bytes into one nam instance: straight into the nam heap (NUL-terminated), no JS string —
    // `NamWasmModule.loadModel` marshals a string, but the worklet scope has no TextDecoder to make one.
    #loadInto(instance: number, json: Uint8Array): boolean {
        const emscripten = this.#emscripten
        if (!isDefined(emscripten)) {return false}
        const jsonPtr = emscripten._malloc(json.length + 1)
        emscripten.HEAPU8.set(json, jsonPtr)
        emscripten.HEAPU8[jsonPtr + json.length] = 0
        const loaded = emscripten._nam_loadModel(instance, jsonPtr)
        emscripten._free(jsonPtr)
        if (!loaded) {console.error("NAM loadModel failed")}
        return !!loaded
    }
}
