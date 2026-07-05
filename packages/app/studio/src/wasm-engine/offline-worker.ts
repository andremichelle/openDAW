// The WASM engine behind the studio's OFFLINE render contract: a Worker speaking the same
// `OfflineEngineProtocol` (+ engine-commands / engine-to-client port channels) as the TS offline engine
// worker, so `OfflineEngineRenderer` drives either engine unchanged — the seam the step-by-step engine
// replacement leans on (device benchmarks, offline parity renders, later exports). The project snapshot
// is decoded here and streamed into the engine as one full-dump transaction; samples/soundfonts/NAM
// arrive over the EngineToClient RPC exactly like the realtime worklet host.
import {Arrays, int, isDefined, Nullable, Option, SyncStream, TimeSpan, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger, Wait} from "@opendaw/lib-runtime"
import {AudioData, dbToGain, ppqn, RenderQuantum} from "@opendaw/lib-dsp"
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {
    ClipSequencingUpdates,
    EngineCommands,
    EngineStateSchema,
    EngineToClient,
    MonitoringMapEntry,
    NoteSignal,
    OfflineEngineInitializeConfig,
    OfflineEngineProtocol,
    OfflineEngineRenderConfig,
    ProjectSkeleton
} from "@opendaw/studio-adapters"
import type {SoundFont2} from "soundfont2"
import {EngineExports} from "../../../wasm/src/engine-exports"
import {createEngineMemory, loadEngineModules} from "../../../wasm/src/engine-modules"
import {serializeUpdateTasks} from "../../../wasm/src/sync/serialize-update-tasks"
import {drainResourceRequests, instantiateWasmEngine} from "./boot"

type EngineState = {
    readonly engine: EngineExports
    readonly memory: WebAssembly.Memory
    readonly stateSender: SyncStream.Writer
    readonly sampleRate: int
    readonly pending: Set<Promise<unknown>>
    totalFrames: int
    running: boolean
}

let state: Option<EngineState> = Option.None

const renderQuantum = (engine: EngineExports, memory: WebAssembly.Memory, out: Float32Array[]): void => {
    engine.render()
    const buffer = memory.buffer // re-read each block: talc may have grown the buffer
    const pointer = engine.output_ptr()
    out[0].set(new Float32Array(buffer, pointer, RenderQuantum))
    if (out.length > 1) {
        out[1].set(new Float32Array(buffer, pointer + RenderQuantum * Float32Array.BYTES_PER_ELEMENT, RenderQuantum))
    }
}

// In this worker `self` is a DedicatedWorkerGlobalScope; the studio tsconfig types it as Window,
// hence the cast onto the Messenger's structural Port.
Communicator.executor<OfflineEngineProtocol>(
    Messenger.for(self as unknown as Parameters<typeof Messenger.for>[0]).channel("offline-engine"), {
        async initialize(enginePort: MessagePort, config: OfflineEngineInitializeConfig) {
            if (config.numberOfChannels !== 2) {
                throw new Error("The WASM offline engine renders the stereo master only (no stem export yet)")
            }
            const variant = config.variant as {wasmUrl: string}
            const modules = await loadEngineModules(variant.wasmUrl)
            const memory = createEngineMemory()
            const messenger = Messenger.for(enginePort)
            const engineToClient = Communicator.sender<EngineToClient>(
                messenger.channel("engine-to-client"),
                dispatcher => new class implements EngineToClient {
                    log(message: string): void {dispatcher.dispatchAndForget(this.log, message)}
                    error(reason: unknown): void {dispatcher.dispatchAndForget(this.error, reason)}
                    deviceMessage(uuid: string, message: string): void {dispatcher.dispatchAndForget(this.deviceMessage, uuid, message)}
                    fetchAudio(uuid: UUID.Bytes): Promise<AudioData> {return dispatcher.dispatchAndReturn(this.fetchAudio, uuid)}
                    fetchSoundfont(uuid: UUID.Bytes): Promise<SoundFont2> {return dispatcher.dispatchAndReturn(this.fetchSoundfont, uuid)}
                    fetchNamWasm(): Promise<ArrayBuffer> {return dispatcher.dispatchAndReturn(this.fetchNamWasm)}
                    notifyClipSequenceChanges(changes: ClipSequencingUpdates): void {
                        dispatcher.dispatchAndForget(this.notifyClipSequenceChanges, changes)
                    }
                    switchMarkerState(markerState: Nullable<[UUID.Bytes, int]>): void {
                        dispatcher.dispatchAndForget(this.switchMarkerState, markerState)
                    }
                    ready() {dispatcher.dispatchAndForget(this.ready)}
                })
            const engine = instantiateWasmEngine(modules, memory, config.sampleRate, engineToClient)
            // Parity with the TS offline engine (metronome preference defaults OFF there); an enabled
            // metronome would also click into the rendered audio.
            engine.set_metronome_enabled(0)
            // The project snapshot as ONE full-dump transaction (the SyncSource initialize analog).
            const {boxGraph} = ProjectSkeleton.decode(config.project)
            const tasks: Array<UpdateTask<BoxIO.TypeMap>> = boxGraph.boxes().map(box =>
                ({type: "new", name: box.name as keyof BoxIO.TypeMap, uuid: box.address.uuid, buffer: box.toArrayBuffer()}))
            const bytes = new Uint8Array(serializeUpdateTasks(tasks, boxGraph))
            const pointer = engine.input_reserve(bytes.length)
            new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
            if (engine.apply_updates(bytes.length) !== 0) {
                throw new Error("apply_updates rejected the project snapshot")
            }
            if (engine.bind() !== 0) {
                throw new Error("the project snapshot carries no TimelineBox")
            }
            const pending: Set<Promise<unknown>> = new Set()
            drainResourceRequests(engine, memory, engineToClient, pending, config.sampleRate)
            const stateSender = SyncStream.writer(EngineStateSchema(), config.syncStreamBuffer, engineState => {
                const view = new DataView(memory.buffer, engine.engine_state_ptr(), engine.engine_state_len())
                engineState.position = view.getFloat32(0)
                engineState.bpm = view.getFloat32(4)
                engineState.playbackTimestamp = 0
                engineState.countInBeatsRemaining = 0
                engineState.isPlaying = view.getUint8(16) === 1
                engineState.isCountingIn = false
                engineState.isRecording = false
            })
            Communicator.executor<EngineCommands>(messenger.channel("engine-commands"), {
                play: (): void => engine.play(),
                stop: (reset: boolean): void => {
                    engine.pause()
                    if (reset) {engine.stop()}
                },
                setPosition: (position: ppqn): void => engine.set_position(position),
                prepareRecordingState: (_countIn: boolean): void => {},
                stopRecording: (): void => {},
                queryLoadingComplete: (): Promise<boolean> => Promise.all(pending).then(() => true),
                panic: (): void => {},
                loadClickSound: (_index: 0 | 1, _data: AudioData): void => {},
                setFrozenAudio: (_uuid: UUID.Bytes, _audioData: Nullable<AudioData>): void => {},
                updateMonitoringMap: (_map: ReadonlyArray<MonitoringMapEntry>): void => {},
                noteSignal: (_signal: NoteSignal): void => {},
                ignoreNoteRegion: (_uuid: UUID.Bytes): void => {},
                scheduleClipPlay: (_clipIds: ReadonlyArray<UUID.Bytes>): void => {},
                scheduleClipStop: (_trackIds: ReadonlyArray<UUID.Bytes>): void => {},
                setupMIDI: (_port: MessagePort, _buffer: SharedArrayBuffer): void => {},
                terminate: (): void => {}
            })
            enginePort.start()
            state = Option.wrap({
                engine, memory, stateSender, pending,
                sampleRate: config.sampleRate,
                totalFrames: 0,
                running: false
            })
            engineToClient.ready()
        },
        // The studio registers scriptable-device user code this way; the wasm ScriptBridges reads the
        // same `globalThis.openDAW` registries the injected code populates.
        async addModule(code: string): Promise<void> {
            new Function(code)()
        },
        async step(numSamples: int): Promise<Float32Array[]> {
            const {engine, memory, stateSender, pending} = state.unwrap("state.step")
            await Promise.all(pending) // resources may resolve lazily after loading was queried
            // The loop stays fully SYNCHRONOUS (like the TS offline worker's step): every resource resolved
            // above, and a per-second `setTimeout(0)` yield would cost more than the render itself (~4ms
            // clamped, ×60 — measured as 260ms of a 297ms empty render).
            const result: Float32Array[] = Arrays.create(() => new Float32Array(numSamples), 2)
            const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), 2)
            let offset = 0 | 0
            while (offset < numSamples) {
                renderQuantum(engine, memory, outputChannels)
                const toCopy = Math.min(numSamples - offset, RenderQuantum)
                for (let channel = 0; channel < 2; channel++) {
                    result[channel].set(outputChannels[channel].subarray(0, toCopy), offset)
                }
                offset += toCopy
                stateSender.tryWrite()
            }
            return result
        },
        async render(config: OfflineEngineRenderConfig) {
            const engine = state.unwrap("state.render")
            const {silenceThresholdDb, silenceDurationSeconds, maxDurationSeconds} = config
            const threshold = dbToGain(silenceThresholdDb ?? -72.0)
            const silenceFramesNeeded = Math.ceil((silenceDurationSeconds ?? 10) * engine.sampleRate)
            const maxFrames = isDefined(maxDurationSeconds) ? Math.ceil(maxDurationSeconds * engine.sampleRate) : Infinity
            const chunks: Float32Array[][] = Arrays.create(() => [], 2)
            let consecutiveSilentFrames = 0
            let hasHadAudio = false
            let lastYield = 0
            engine.running = true
            await Wait.timeSpan(TimeSpan.seconds(0))
            while (engine.running && engine.totalFrames < maxFrames) {
                const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), 2)
                renderQuantum(engine.engine, engine.memory, outputChannels)
                let maxSample = 0
                for (const channel of outputChannels) {
                    for (const sample of channel) {
                        const absoluteValue = Math.abs(sample)
                        if (absoluteValue > maxSample) {maxSample = absoluteValue}
                    }
                }
                const isSilent = maxSample <= threshold
                if (maxSample > threshold) {hasHadAudio = true}
                if (isSilent && hasHadAudio) {
                    consecutiveSilentFrames += RenderQuantum
                    if (consecutiveSilentFrames >= silenceFramesNeeded) {break}
                } else {
                    consecutiveSilentFrames = 0
                }
                for (let channel = 0; channel < 2; channel++) {
                    chunks[channel].push(outputChannels[channel].slice())
                }
                engine.totalFrames += RenderQuantum
                engine.stateSender.tryWrite()
                if (engine.totalFrames - lastYield >= engine.sampleRate) {
                    lastYield = engine.totalFrames
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
            }
            const framesToKeep = engine.totalFrames - consecutiveSilentFrames + Math.min(engine.sampleRate / 4, consecutiveSilentFrames)
            return Arrays.create(channelIndex => {
                const total = new Float32Array(framesToKeep)
                let offset = 0
                for (const chunk of chunks[channelIndex]) {
                    if (offset >= framesToKeep) {break}
                    const toCopy = Math.min(chunk.length, framesToKeep - offset)
                    total.set(chunk.subarray(0, toCopy), offset)
                    offset += toCopy
                }
                return total
            }, 2)
        },
        stop() { state.unwrap("state.stop").running = false }
    }
)

export {}
