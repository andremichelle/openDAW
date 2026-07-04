// OFFLINE render of a bundle through BOTH engines, as fast as possible (no AudioContext, no realtime): drive
// the render loop directly and time ONLY that loop (setup / decode / sample-load / bind are excluded). The WASM
// path links the engine + device side-modules exactly like the AudioWorklet (mirrors test/helpers/load-full-
// engine) and calls `engine.render()` per quantum. The TS path instantiates the real studio `EngineProcessor`
// headless (mirrors test/helpers/render-ts) and calls `processor.process(...)` per quantum. Both capture the
// stereo master into planar Float32Arrays for A/B playback.
import {Arrays, type Nullable, SyncStream, UUID} from "@opendaw/lib-std"
import {AudioData, type ppqn, RenderQuantum, WavFile} from "@opendaw/lib-dsp"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {ApparatDeviceBox, BoxIO, SpielwerkDeviceBox, TimelineBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {EngineCommands, EngineState, EngineStateSchema, EngineToClient, MonitoringMapEntry, NoteSignal, ScriptCompiler} from "@opendaw/studio-adapters"
import {setupWorkletGlobals, updateFrameTime, type WorkletGlobals} from "../../../../studio/core-workers/src/worklet-env"
import {serializeUpdateTasks} from "../sync/serialize-update-tasks"
import {ScriptBridges, ScriptEngine} from "../script-bridge"
import {NamBridges} from "../nam-bridge"
import {linkDevice, registerComposite} from "../device-linker"
import {loadEngineModules} from "../engine-modules"
import {loadSoundfontBlob, parseSoundfont, simplifySoundfontBytes} from "../soundfont-fetch"
import type {Bundle} from "../bundle"
import type {OfflineResult} from "./result"


// Register the user scripts of every scriptable device (Werkstatt / Apparat / Spielwerk) into `globalThis.openDAW`,
// mirroring OfflineEngineRenderer.loadScriptDevice. Without this those devices have no processor: the TS engine
// (and the wasm ScriptBridges, which reads the same globals) can't voice/process them. A project that routes tracks
// through unregistered scriptable effects/instruments renders silent. Runs the box `code` as the studio does.
const registerScriptDevice = (code: string, header: RegExp, registry: string, fn: string, uuid: string): void => {
    const match = code.match(header)
    if (match === null) {return}
    const update = parseInt(match[3])
    const userCode = code.slice(match[0].length)
    // Use ScriptCompiler.wrap (NOT a hand-rolled entry): it also carries the parsed @param / @sample declarations
    // the WASM ScriptBridges needs (it does `registry.params.map(...)` / `registry.samples.map(...)`). Omitting them
    // makes the bridge throw and SILENCE the device — which is why Open Up rendered silent in WASM.
    new Function(ScriptCompiler.wrap({headerTag: fn, registryName: registry, functionName: fn}, uuid, update, userCode))()
}

export const registerScriptDevices = (boxGraph: BoxGraph): void => {
    for (const box of boxGraph.boxes()) {
        if (box instanceof WerkstattDeviceBox) {
            registerScriptDevice(box.code.getValue(), /^\/\/ @werkstatt (\w+) (\d+) (\d+)\n/, "werkstattProcessors", "werkstatt", UUID.toString(box.address.uuid))
        } else if (box instanceof ApparatDeviceBox) {
            registerScriptDevice(box.code.getValue(), /^\/\/ @apparat (\w+) (\d+) (\d+)\n/, "apparatProcessors", "apparat", UUID.toString(box.address.uuid))
        } else if (box instanceof SpielwerkDeviceBox) {
            registerScriptDevice(box.code.getValue(), /^\/\/ @spielwerk (\w+) (\d+) (\d+)\n/, "spielwerkProcessors", "spielwerk", UUID.toString(box.address.uuid))
        }
    }
}

// Disable the timeline loop area so a front-to-end render plays the whole arrangement instead of looping a
// section forever (the studio's OfflineEngineRenderer does the same before an export).
export const disableLoopArea = (boxGraph: BoxGraph): void => {
    let timeline: TimelineBox | undefined
    for (const box of boxGraph.boxes()) {
        if (box instanceof TimelineBox) {timeline = box; break}
    }
    if (timeline === undefined || !timeline.loopArea.enabled.getValue()) {return}
    boxGraph.beginTransaction()
    timeline.loopArea.enabled.setValue(false)
    boxGraph.endTransaction()
}

// Wire the source box graph into the engine over the unchanged SyncSource (a BroadcastChannel loopback), with a
// deterministic `settle()` (mirrors test/helpers/connect-sync).
let channelCounter = 0
const connectSync = (engine: any, memory: WebAssembly.Memory, source: {checksum(): Int8Array}) => {
    const channelName = `perf-sync-${channelCounter++}`
    const engineChecksum = (): Int8Array => new Int8Array(memory.buffer, engine.checksum_ptr(), 32).slice()
    const target: Synchronization<BoxIO.TypeMap> = {
        sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
            const bytes = new Uint8Array(serializeUpdateTasks(tasks, source as never))
            const pointer = engine.input_reserve(bytes.length)
            new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
            if (engine.apply_updates(bytes.length) !== 0) {throw new Error("apply_updates rejected a transaction")}
        },
        checksum(value: Int8Array): Promise<void> {
            const actual = engineChecksum()
            return value.every((byte, index) => byte === actual[index])
                ? Promise.resolve() : Promise.reject(new Error("engine checksum diverged from the source"))
        }
    }
    const a = new BroadcastChannel(channelName)
    const b = new BroadcastChannel(channelName)
    Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(b), target)
    const syncSource = new SyncSource<BoxIO.TypeMap>(source as never, Messenger.for(a), true)
    return {settle: () => syncSource.checksum(source.checksum()), close: () => {a.close(); b.close()}}
}

// Feed the bundle's samples + soundfonts into the engine's request queues (excluded from render timing).
const drainResources = async (engine: any, memory: WebAssembly.Memory, bundle: Bundle): Promise<void> => {
    for (; ;) {
        const rp = engine.input_reserve(16)
        const handle = engine.sample_take_request(rp)
        if (handle < 0) {break}
        const uuid = UUID.toString(new Uint8Array(memory.buffer.slice(rp, rp + 16)) as UUID.Bytes)
        const sample = bundle.samples.find(entry => UUID.toString(entry.uuid) === uuid)
        if (sample === undefined) {engine.sample_allocate(handle, 4); engine.sample_set_ready(handle, 1, 1, 48000); continue}
        const data = WavFile.decodeFloats(sample.wav)
        const pointer = engine.sample_allocate(handle, data.numberOfFrames * data.numberOfChannels * 4)
        for (let channel = 0; channel < data.numberOfChannels; channel++) {
            new Float32Array(memory.buffer, pointer + channel * data.numberOfFrames * 4, data.numberOfFrames).set(data.frames[channel])
        }
        engine.sample_set_ready(handle, data.numberOfFrames, data.numberOfChannels, data.sampleRate)
    }
    for (; ;) {
        const rp = engine.input_reserve(16)
        const handle = engine.soundfont_take_request(rp)
        if (handle < 0) {break}
        const uuid = new Uint8Array(memory.buffer.slice(rp, rp + 16)) as UUID.Bytes
        const uuidString = UUID.toString(uuid)
        const carried = bundle.soundfonts.find(entry => UUID.toString(entry.uuid) === uuidString)
        try {
            // Prefer the .sf2 the bundle carries (no network); fall back to the asset server otherwise.
            const blob = new Uint8Array(carried !== undefined ? await simplifySoundfontBytes(carried.sf2) : await loadSoundfontBlob(uuid))
            const pointer = engine.soundfont_allocate(handle, blob.byteLength)
            new Uint8Array(memory.buffer, pointer, blob.byteLength).set(blob)
            engine.soundfont_set_ready(handle)
        } catch (_error) { /* offline / missing: the device stays silent, still a valid render */ }
    }
}

export const renderWasmOffline = async (bundle: Bundle, quanta: number, sampleRate = 48000): Promise<OfflineResult> => {
    const {engineModule, deviceModules, deviceBoxTypes, composites} = await loadEngineModules()
    const memory = new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})
    const table = new WebAssembly.Table({initial: 512, element: "anyfunc"})
    const engine = new WebAssembly.Instance(engineModule, {env: {
        memory, __indirect_function_table: table,
        host_perf_now: () => performance.now() * 1000.0 // micros clock for the render profiler
    }}).exports as any
    engine.init(sampleRate)
    ;(globalThis as any).sampleRate = sampleRate
    const scriptBridges = new ScriptBridges(memory, engine as ScriptEngine, sampleRate,
        (uuid, message) => console.warn(`[perf] scriptable device ${uuid}: ${message}`))
    const scriptImports = scriptBridges.imports()
    // The NeuralAmp devices' inference bridge: the perf worker fetches the `@opendaw/nam-wasm` binary itself
    // (lazily, on the first model load) — the same recipe as the engine host, no worklet RPC needed here.
    const namBridges = new NamBridges(memory, async () => {
        const url = new URL("@opendaw/nam-wasm/nam.wasm", import.meta.url)
        return (await fetch(url)).arrayBuffer()
    }, sampleRate)
    const namImports = namBridges.imports()
    for (let index = 0; index < deviceModules.length; index++) {
        linkDevice(engine, memory, table, deviceModules[index], deviceBoxTypes[index], sampleRate, {...scriptImports, ...namImports})
    }
    for (const composite of composites) {
        registerComposite(engine, memory, composite)
    }
    const sync = connectSync(engine, memory, bundle.boxGraph)
    await sync.settle(); engine.bind(); await sync.settle()
    await drainResources(engine, memory, bundle)
    await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    const half = len >>> 1
    const left = new Float32Array(quanta * half), right = new Float32Array(quanta * half)
    engine.stop(); engine.play()
    const t0 = performance.now()
    for (let q = 0; q < quanta; q++) {
        engine.render()
        const out = new Float32Array(memory.buffer, engine.output_ptr(), len)
        left.set(out.subarray(0, half), q * half)
        right.set(out.subarray(half, len), q * half)
    }
    const renderMs = performance.now() - t0
    sync.close()
    return {left, right, renderMs, sampleRate}
}

export const renderTsOffline = async (bundle: Bundle, quanta: number, sampleRate = 48000): Promise<OfflineResult> => {
    setupWorkletGlobals({sampleRate})
    const globals = globalThis as unknown as WorkletGlobals
    const sampleMap = new Map<string, AudioData>()
    for (const {uuid, wav} of bundle.samples) {sampleMap.set(UUID.toString(uuid), WavFile.decodeFloats(wav))}
    const channel = new MessageChannel()
    globals.__workletPort__ = channel.port1 as unknown as MessagePort
    const reader = SyncStream.reader<EngineState>(EngineStateSchema(), () => {})
    const messenger = Messenger.for(channel.port2 as unknown as MessagePort)
    Communicator.executor<EngineToClient>(messenger.channel("engine-to-client"), {
        log: (): void => {}, error: (): void => {}, ready: (): void => {}, deviceMessage: (): void => {},
        fetchAudio: (uuid: UUID.Bytes): Promise<AudioData> => {
            // Resolve a 1-frame silence for a sample the bundle does not carry, so a missing asset never leaves
            // the engine's loader stuck (which would render the whole project silent) — it just plays nothing.
            const data = sampleMap.get(UUID.toString(uuid))
            return Promise.resolve(data ?? AudioData.create(sampleRate, 1, 1))
        },
        fetchSoundfont: (uuid: UUID.Bytes) => {
            const carried = bundle.soundfonts.find(entry => UUID.toString(entry.uuid) === UUID.toString(uuid))
            return carried !== undefined ? parseSoundfont(carried.sf2) : Promise.reject(new Error("missing soundfont"))
        },
        // Both engines must see the same NAM binary, or the A/B compares a playing amp against a silent one.
        fetchNamWasm: async (): Promise<ArrayBuffer> => {
            const url = new URL("@opendaw/nam-wasm/nam.wasm", import.meta.url)
            return (await fetch(url)).arrayBuffer()
        },
        notifyClipSequenceChanges: (): void => {}, switchMarkerState: (): void => {}
    })
    const engineCommands = Communicator.sender<EngineCommands>(messenger.channel("engine-commands"),
        dispatcher => new class implements EngineCommands {
            play(): void {dispatcher.dispatchAndForget(this.play)}
            stop(reset: boolean): void {dispatcher.dispatchAndForget(this.stop, reset)}
            setPosition(position: ppqn): void {dispatcher.dispatchAndForget(this.setPosition, position)}
            prepareRecordingState(countIn: boolean): void {dispatcher.dispatchAndForget(this.prepareRecordingState, countIn)}
            stopRecording(): void {dispatcher.dispatchAndForget(this.stopRecording)}
            queryLoadingComplete(): Promise<boolean> {return dispatcher.dispatchAndReturn(this.queryLoadingComplete)}
            panic(): void {dispatcher.dispatchAndForget(this.panic)}
            noteSignal(signal: NoteSignal): void {dispatcher.dispatchAndForget(this.noteSignal, signal)}
            ignoreNoteRegion(uuid: UUID.Bytes): void {dispatcher.dispatchAndForget(this.ignoreNoteRegion, uuid)}
            scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void {dispatcher.dispatchAndForget(this.scheduleClipPlay, clipIds)}
            scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void {dispatcher.dispatchAndForget(this.scheduleClipStop, trackIds)}
            setupMIDI(port: MessagePort, buffer: SharedArrayBuffer): void {dispatcher.dispatchAndForget(this.setupMIDI, port, buffer)}
            updateMonitoringMap(map: ReadonlyArray<MonitoringMapEntry>): void {dispatcher.dispatchAndForget(this.updateMonitoringMap, map)}
            loadClickSound(index: 0 | 1, data: AudioData): void {dispatcher.dispatchAndForget(this.loadClickSound, index, data)}
            setFrozenAudio(uuid: UUID.Bytes, audioData: Nullable<AudioData>): void {dispatcher.dispatchAndForget(this.setFrozenAudio, uuid, audioData)}
            terminate(): void {dispatcher.dispatchAndForget(this.terminate)}
        })
    channel.port2.start()
    const {EngineProcessor} = await import("../../../../studio/core-processors/src/EngineProcessor")
    const processor = new EngineProcessor({
        processorOptions: {
            syncStreamBuffer: reader.buffer,
            controlFlagsBuffer: new SharedArrayBuffer(4),
            hrClockBuffer: new SharedArrayBuffer(32),
            project: bundle.project,
            exportConfiguration: undefined
        }
    })
    for (let attempt = 0; attempt < 400; attempt++) {
        if (await engineCommands.queryLoadingComplete()) {break}
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    engineCommands.play()
    await new Promise(resolve => setTimeout(resolve, 10))
    const half = RenderQuantum
    const left = new Float32Array(quanta * half), right = new Float32Array(quanta * half)
    // Pre-allocate the per-quantum output buffers ONCE and clear-reuse them, so the timed loop measures the DSP,
    // not per-quantum allocation (a fair comparison with the WASM path). The worklet hands fresh zeroed buffers
    // each block, so clearing reproduces that exactly.
    const channels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), 2)
    const outputs: Float32Array[][] = [channels]
    let totalFrames = 0, lastYield = 0, renderMs = 0
    let segmentStart = performance.now()
    for (let q = 0; q < quanta; q++) {
        channels[0].fill(0.0)
        channels[1].fill(0.0)
        updateFrameTime(totalFrames, sampleRate)
        processor.process([[]], outputs)
        totalFrames += RenderQuantum
        left.set(channels[0], q * half)
        right.set(channels[1], q * half)
        // Yield to the event loop every ~1 s of rendered audio so the async fetchAudio / fetchSoundfont deliveries
        // land (the engine requests some assets lazily when a region starts, AFTER queryLoadingComplete). Mirrors
        // the studio offline-engine worker. Only the compute time is accumulated, so `renderMs` stays accurate.
        if (totalFrames - lastYield >= sampleRate) {
            lastYield = totalFrames
            renderMs += performance.now() - segmentStart
            await new Promise(resolve => setTimeout(resolve, 0))
            segmentStart = performance.now()
        }
    }
    renderMs += performance.now() - segmentStart
    return {left, right, renderMs, sampleRate}
}
