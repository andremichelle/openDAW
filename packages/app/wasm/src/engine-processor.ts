// Runs the engine wasm on the audio thread. The engine is the dynamic-linker host: it owns the ONE shared
// linear memory + function table, and loads each device as a PIC SIDE MODULE at a host-assigned base. The
// loader here (per device) reads its `dylink.0`, allocates its data region + stack from the engine's talc
// (device_alloc), sets the device's imported __memory_base / __table_base / __stack_pointer, applies its
// data relocations, installs its `process` into the shared table, and registers it (device_register). The
// engine then calls each device via call_indirect on that table slot — wasm-to-wasm, zero copy. So any
// number of distinct device modules coexist in the one memory with no fixed addresses.
//
// The engine holds the wasm BoxGraph mirror; the main thread serializes SyncSource's UpdateTask[] into
// bytes and posts them here. Each batch -> apply_updates, then bind() once the TimelineBox exists.

import "./worklet-scope" // MUST be first: shims `self`/`location` for inlined worker glue
import {isDefined, Terminable, UUID} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {LiveStreamBroadcaster} from "@opendaw/lib-fusion"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {CompositeSpec} from "./engine-modules"
import {SampleInfo, SampleLoader} from "./sample-loader"
import {SoundfontInfo, SoundfontLoader} from "./soundfont-loader"
import {EngineProtocol, HeapListener, HeapStats, ScriptListener, TransportListener} from "./engine-protocol"
import {ScriptBridges, ScriptEngine} from "./script-bridge"
import {NamBridges} from "./nam-bridge"
import {linkDevice, registerComposite} from "./device-linker"
import {NamLoader} from "./nam-loader"
import {EngineExports} from "./engine-exports"

const ENGINE_TABLE_RESERVE = 512 // shared table slots reserved for the engine's own functions (it needs ~42)

type BootOptions = {
    engineModule: WebAssembly.Module
    deviceModules: ReadonlyArray<WebAssembly.Module> // PIC side modules, in load order (device 0, 1, ...)
    deviceBoxTypes: ReadonlyArray<string> // parallel to deviceModules: the device-box type each plugin realizes
    composites: ReadonlyArray<CompositeSpec> // composite box types the engine hosts as child collections
    memory: WebAssembly.Memory // SHARED, created on the main thread so it can see the WASM heap
    sampleRate: number
    metronome?: boolean // default true; the note's page sets false to hear only the instrument
}

// Read a varuint32 (LEB128) at `pos`; returns [value, nextPos].
class EngineProcessor extends AudioWorkletProcessor {
    readonly #memory: WebAssembly.Memory
    readonly #engine: EngineExports
    readonly #table: WebAssembly.Table
    readonly #sampleRate: number
    #bound: boolean = false
    #sinceStats: number = 0
    #sinceState: number = 0
    #transport!: TransportListener // transport-state back-channel sender (set in the constructor)
    #heap!: HeapListener // heap-stats back-channel sender (set in the constructor)
    #loader!: SampleLoader // the sample-load RPC sender (set in the constructor)
    #soundfontLoader!: SoundfontLoader // the soundfont-load RPC sender (set in the constructor)
    #scripts!: ScriptListener // scriptable-device error back-channel sender (set in the constructor)
    #namLoader!: NamLoader // the nam-wasm binary RPC sender (set in the constructor)
    readonly #scriptBridges: ScriptBridges // runs the scriptable devices' user JS over the shared memory
    readonly #namBridges: NamBridges // runs the NeuralAmp devices' nam-wasm inference next to the engine
    // The live-telemetry bridge: the UNCHANGED lib-fusion protocol, fed by Float32Array views over the
    // engine's broadcast slots (shared-memory views survive talc growth, so a view registers once).
    readonly #broadcaster: LiveStreamBroadcaster
    readonly #broadcastSubs: Array<Terminable> = []
    #broadcastGeneration: number = -1

    constructor(options?: AudioWorkletNodeOptions) {
        super()
        const {engineModule, deviceModules, deviceBoxTypes, composites, memory, sampleRate, metronome}: BootOptions = options?.processorOptions
        this.#sampleRate = sampleRate
        // the one SHARED linear memory, created on the main thread and handed in (so the main thread can
        // see the WASM heap). talc grows it on demand; shared memory grows in place without detaching.
        this.#memory = memory
        // the one shared function table: the engine (main module) imports it and uses the low slots; each
        // device's functions + its `process` entry are appended above via table.grow.
        this.#table = new WebAssembly.Table({initial: ENGINE_TABLE_RESERVE, element: "anyfunc"})
        // micros clock for the render profiler; the AudioWorkletGlobalScope has no `performance`, Date.now
        // (ms resolution) is the honest fallback there — profile in the offline/test contexts for precision.
        const now: () => number = isDefined(globalThis.performance) ? () => performance.now() * 1000.0 : () => Date.now() * 1000.0
        const env = {memory, __indirect_function_table: this.#table, host_perf_now: now}
        // the engine is the dynamic-linker host; instantiate it first, before any device.
        const engine = new WebAssembly.Instance(engineModule, {env}).exports as unknown as EngineExports
        this.#engine = engine
        engine.init(sampleRate)
        // The script bridge runs the scriptable devices' user JavaScript over the shared memory; its `host_script_*`
        // closures are bound into each scriptable device's env at load. A user-script error reports out on the
        // `script` back-channel (set up below; the closure runs only during render, by which point it is wired).
        this.#scriptBridges = new ScriptBridges(memory, engine as unknown as ScriptEngine, sampleRate,
            (uuid, message) => this.#scripts.deviceMessage(uuid, message))
        const scriptImports = this.#scriptBridges.imports()
        // The nam bridge runs the NeuralAmp devices' inference in the `@opendaw/nam-wasm` module, instantiated
        // lazily next to the engine on the first model load (the binary arrives over the `nam` RPC channel).
        this.#namBridges = new NamBridges(memory, () => this.#namLoader.fetchWasm(), sampleRate)
        const bridgeImports = {...scriptImports, ...this.#namBridges.imports()}
        // load each device PIC side module at a host-assigned base, register it, and map its box type.
        deviceModules.forEach((deviceModule, index) =>
            linkDevice(engine, memory, this.#table, deviceModule, deviceBoxTypes[index], sampleRate, bridgeImports))
        composites.forEach(composite => registerComposite(engine, memory, composite))
        if (metronome === false) {engine.set_metronome_enabled(0)}
        // ONE Messenger over the engine port, split into typed Communicator protocols, one per named channel
        // (each channel is a single sender -> executor direction): `engine` receives the SyncSource transaction
        // bytes (this side EXECUTES), `transport` / `heap` push the back-channels out (this side SENDS), and
        // `samples` drives the sample-load RPC (this side SENDS). The senders are set up here, so they are ready
        // before any transport-state tick or AudioFileBox load.
        const processor = this
        const messenger = Messenger.for(this.port)
        Communicator.executor<EngineProtocol>(messenger.channel("engine"), new class implements EngineProtocol {
            applyUpdates(bytes: ArrayBuffer): void {processor.#applyUpdates(bytes)}
            play(): void {processor.#engine?.play()}
            pause(): void {processor.#engine?.pause()}
            stop(): void {processor.#engine?.stop()}
        })
        this.#transport = Communicator.sender<TransportListener>(messenger.channel("transport"), dispatcher => new class implements TransportListener {
            state(bytes: ArrayBuffer): void {dispatcher.dispatchAndForget(this.state, Communicator.makeTransferable(bytes))}
        })
        this.#heap = Communicator.sender<HeapListener>(messenger.channel("heap"), dispatcher => new class implements HeapListener {
            heap(stats: HeapStats): void {dispatcher.dispatchAndForget(this.heap, stats)}
        })
        this.#loader = Communicator.sender<SampleLoader>(messenger.channel("samples"), dispatcher => new class implements SampleLoader {
            decode(uuid: UUID.Bytes): Promise<SampleInfo> {return dispatcher.dispatchAndReturn(this.decode, uuid)}
            write(uuid: UUID.Bytes, pointer: number): Promise<void> {return dispatcher.dispatchAndReturn(this.write, uuid, pointer)}
        })
        this.#soundfontLoader = Communicator.sender<SoundfontLoader>(messenger.channel("soundfonts"), dispatcher => new class implements SoundfontLoader {
            decode(uuid: UUID.Bytes): Promise<SoundfontInfo> {return dispatcher.dispatchAndReturn(this.decode, uuid)}
            write(uuid: UUID.Bytes, pointer: number): Promise<void> {return dispatcher.dispatchAndReturn(this.write, uuid, pointer)}
        })
        this.#scripts = Communicator.sender<ScriptListener>(messenger.channel("script"), dispatcher => new class implements ScriptListener {
            deviceMessage(uuid: string, message: string): void {dispatcher.dispatchAndForget(this.deviceMessage, uuid, message)}
        })
        this.#namLoader = Communicator.sender<NamLoader>(messenger.channel("nam"), dispatcher => new class implements NamLoader {
            fetchWasm(): Promise<ArrayBuffer> {return dispatcher.dispatchAndReturn(this.fetchWasm)}
        })
        this.#broadcaster = LiveStreamBroadcaster.create(messenger, "engine-live-data")
    }

    // Mirror the engine's broadcast table onto the LiveStreamBroadcaster whenever its generation moved (a
    // reconcile registered or swept telemetry slots): terminate every stale package, then register each entry
    // as a package whose Float32Array view points straight into wasm memory — the broadcaster reads the LIVE
    // values at flush, so the render path never copies. Entry indices are only valid for this generation; a
    // sweep re-runs this, so a captured `index` in the subscription round-trip can never go stale.
    #syncBroadcasts(): void {
        const generation = this.#engine.broadcast_generation()
        if (generation === this.#broadcastGeneration) {return}
        this.#broadcastGeneration = generation
        this.#broadcastSubs.forEach(subscription => subscription.terminate())
        this.#broadcastSubs.length = 0
        const count = this.#engine.broadcast_count()
        for (let index = 0; index < count; index++) {
            const recordPtr = this.#engine.input_reserve(48)
            if (this.#engine.broadcast_entry(index, recordPtr) === 0) {continue}
            // [uuid 16][package_type u32][ptr u32][len u32][keys_count u32][keys u16 x 8], little-endian
            const record = new DataView(this.#memory.buffer, recordPtr, 48)
            const uuid = new Uint8Array(this.#memory.buffer, recordPtr, 16).slice()
            const packageType = record.getUint32(16, true)
            const ptr = record.getUint32(20, true)
            const len = record.getUint32(24, true)
            const keysCount = record.getUint32(28, true)
            const keys: Array<number> = []
            for (let position = 0; position < keysCount; position++) {
                keys.push(record.getUint16(32 + position * 2, true))
            }
            const address = Address.compose(uuid, ...keys)
            const values = new Float32Array(this.#memory.buffer, ptr, len)
            if (packageType === 0) { // PackageType.Float
                this.#broadcastSubs.push(this.#broadcaster.broadcastFloat(address, () => values[0]))
            } else { // PackageType.FloatArray
                this.#broadcastSubs.push(this.#broadcaster.broadcastFloats(address, values,
                    hasSubscribers => this.#engine.broadcast_set_active(index, hasSubscribers ? 1 : 0)))
            }
        }
    }

    // Pop every sample the engine queued (on seeing an AudioFileBox) and run the load handshake for each:
    // decode (main fetches + decodes, reports the size), allocate the engine storage, write the planar frames
    // into the SAB, mark ready. Each runs as its own async chain off the render path; a wrong sample never
    // blocks the others. The 16-byte uuid is copied out of the (reused) input scratch BEFORE any await.
    #drainSampleRequests(): void {
        const loader = this.#loader
        for (; ;) {
            const outPtr = this.#engine.input_reserve(16)
            const handle = this.#engine.sample_take_request(outPtr)
            if (handle < 0) {break}
            const uuid = new Uint8Array(this.#memory.buffer, outPtr, 16).slice()
            void (async () => {
                const info = await loader.decode(uuid)
                const pointer = this.#engine.sample_allocate(handle, info.byteLength)
                await loader.write(uuid, pointer)
                this.#engine.sample_set_ready(handle, info.frameCount, info.channelCount, info.sampleRate)
            })().catch((reason: unknown) => {
                // A failed fetch/decode must not become an unhandled rejection: mark the handle ready as a
                // 1-frame silence (the missing-asset convention) so the load never sticks, and report it.
                this.#engine.sample_allocate(handle, 4)
                this.#engine.sample_set_ready(handle, 1, 1, sampleRate)
                this.#scripts.deviceMessage("engine", `sample load failed: ${reason}`)
            })
        }
    }

    // The soundfont analog of `#drainSampleRequests`: the main-thread loader parses the .sf2 + builds the
    // simplified blob, reports its size, and writes it into the engine allocation. Each request runs as its own
    // async chain so a slow/failed soundfont never blocks others.
    #drainSoundfontRequests(): void {
        const loader = this.#soundfontLoader
        for (; ;) {
            const outPtr = this.#engine.input_reserve(16)
            const handle = this.#engine.soundfont_take_request(outPtr)
            if (handle < 0) {break}
            const uuid = new Uint8Array(this.#memory.buffer, outPtr, 16).slice()
            void (async () => {
                const info = await loader.decode(uuid)
                const pointer = this.#engine.soundfont_allocate(handle, info.byteLength)
                await loader.write(uuid, pointer)
                this.#engine.soundfont_set_ready(handle)
            })().catch((reason: unknown) => {
                this.#scripts.deviceMessage("engine", `soundfont load failed: ${reason}`)
            })
        }
    }

    #applyUpdates(bytes: ArrayBuffer): void {
        const array = new Uint8Array(bytes)
        // ensure the engine's input scratch holds this transaction, growing it if needed (kept at the
        // high-water mark). The returned pointer is current even if a grow moved the buffer. So a large
        // transaction is never silently dropped (which would desync the engine's box graph).
        const pointer = this.#engine.input_reserve(array.length)
        new Uint8Array(this.#memory.buffer, pointer, array.length).set(array)
        const rejected = this.#engine.apply_updates(array.length)
        if (rejected !== 0) {
            // A rejected transaction permanently desyncs the engine's box-graph mirror: SAY SO loudly (the
            // back-channel reaches the client console) instead of silently playing a stale graph.
            this.#scripts.deviceMessage("engine", `apply_updates rejected a transaction (code ${rejected}); the engine graph is desynced`)
        }
        if (!this.#bound && this.#engine.bind() === 0) {this.#bound = true}
        // A transaction may have added AudioFileBoxes (the engine queued their loads); dispatch them.
        this.#drainSampleRequests()
        // Likewise a SoundfontFileBox target queues a soundfont blob build; dispatch those too.
        this.#drainSoundfontRequests()
        // Emit heap stats off-render so the panel updates while the context is suspended (a scrub never
        // calls `process`); a delete that frees a sample is then visible as Heap-used dropping at once.
        this.#heap.heap({
            heapUsed: this.#engine.heap_used(),
            heapClaimed: this.#engine.heap_claimed(),
            memoryTotal: this.#memory.buffer.byteLength
        })
    }

    process(_inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean {
        const out = outputs[0]
        if (out.length === 0) {return true}
        this.#engine.render()
        const frames = out[0].length // the render quantum (128)
        const buffer = this.#memory.buffer // re-read each block: talc may have grown (detached) the buffer
        const pointer = this.#engine.output_ptr()
        const left = new Float32Array(buffer, pointer, frames)
        const right = new Float32Array(buffer, pointer + frames * Float32Array.BYTES_PER_ELEMENT, frames)
        out[0].set(left)
        if (out.length > 1) {out[1].set(right)}
        this.#sinceState += frames
        if (this.#sinceState >= this.#sampleRate / 30) { // ~30 Hz transport-state back-channel
            this.#sinceState = 0
            const length = this.#engine.engine_state_len()
            const bytes = new Uint8Array(buffer, this.#engine.engine_state_ptr(), length).slice().buffer
            this.#transport.state(bytes)
        }
        this.#syncBroadcasts()
        this.#broadcaster.flush()
        this.#sinceStats += frames
        if (this.#sinceStats >= this.#sampleRate) { // ~once per second of audio
            this.#sinceStats = 0
            this.#heap.heap({
                heapUsed: this.#engine.heap_used(),
                heapClaimed: this.#engine.heap_claimed(),
                memoryTotal: this.#memory.buffer.byteLength
            })
        }
        return true
    }
}

registerProcessor("engine", EngineProcessor)

export {} // isolate this file's module scope from other worklets
