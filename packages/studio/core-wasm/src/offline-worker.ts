// The WASM engine behind the studio's OFFLINE render contract: a Worker speaking the same
// `OfflineEngineProtocol` (+ engine-commands / engine-to-client port channels) as the TS offline engine
// worker, so `OfflineEngineRenderer` drives either engine unchanged — the seam the step-by-step engine
// replacement leans on (device benchmarks, offline parity renders, later exports). The project snapshot
// is decoded here and streamed into the engine as one full-dump transaction; samples/soundfonts/NAM
// arrive over the EngineToClient RPC exactly like the realtime worklet host.
import {Arrays, int, isDefined, Nullable, Option, SyncStream, Terminable, TimeSpan, tryCatch, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger, Wait} from "@opendaw/lib-runtime"
import {AudioAnalyser, AudioData, dbToGain, ppqn, RenderQuantum} from "@opendaw/lib-dsp"
import {LiveStreamBroadcaster} from "@opendaw/lib-fusion"
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {
    ClipSequencingUpdates,
    EngineAddresses,
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
import {EngineExports} from "./engine-exports"
import {createEngineMemory, loadEngineModules} from "./engine-modules"
import {serializeUpdateTasks} from "./sync/serialize-update-tasks"
import {WasmMidiDrain} from "./midi-drain"
import {describeEngineTrap, drainResourceRequests, instantiateWasmEngine} from "./boot"

type EngineState = {
    readonly engine: EngineExports
    readonly memory: WebAssembly.Memory
    readonly stateSender: SyncStream.Writer
    readonly sampleRate: int
    readonly pending: Set<Promise<unknown>>
    readonly numberOfChannels: int // 2 for a mixdown; stems * 2 for a stem export
    readonly stems: int // 0 = mixdown (the master output); > 0 = read the stem staging
    readonly midi: WasmMidiDrain // TS offline renders emit MIDI too (the offline worker hosts the full EngineProcessor)
    // Master telemetry over "engine-live-data" (mirrors the realtime processor + the TS EngineProcessor), so a
    // live-stream consumer of an offline render — the video export's shadertoy reads SPECTRUM/WAVEFORM — gets data.
    readonly broadcaster: LiveStreamBroadcaster
    readonly analyser: AudioAnalyser
    readonly broadcasts: ReadonlyArray<Terminable>
    totalFrames: int
    running: boolean
}

let state: Option<EngineState> = Option.None

const renderQuantum = (engine: EngineExports, memory: WebAssembly.Memory, out: Float32Array[], stems: number,
                       midi: WasmMidiDrain, analyser: AudioAnalyser, broadcaster: LiveStreamBroadcaster): void => {
    const rendered = tryCatch(() => engine.render())
    if (rendered.status === "failure") {
        // A wasm trap is an anonymous RuntimeError; the panic handler left the real message in its buffer.
        throw describeEngineTrap(engine, memory, rendered.error)
    }
    midi.drain(engine, memory)
    const buffer = memory.buffer // re-read each block: talc may have grown the buffer
    if (stems > 0) {
        // STEM export: each stem's tap lands planar in the stem staging (stem i -> channels 2i / 2i+1).
        const staging = new Float32Array(buffer, engine.stem_output_ptr(), stems * 2 * RenderQuantum)
        for (let channel = 0; channel < out.length && channel < stems * 2; channel++) {
            out[channel].set(staging.subarray(channel * RenderQuantum, (channel + 1) * RenderQuantum))
        }
        return
    }
    const pointer = engine.output_ptr()
    out[0].set(new Float32Array(buffer, pointer, RenderQuantum))
    if (out.length > 1) {
        out[1].set(new Float32Array(buffer, pointer + RenderQuantum * Float32Array.BYTES_PER_ELEMENT, RenderQuantum))
    }
    // Feed the master analyser and flush the live stream every quantum, exactly like the realtime processor,
    // so an offline live-stream consumer (the video export's shadertoy) receives SPECTRUM/WAVEFORM.
    analyser.process(out[0], out[1] ?? out[0], 0, RenderQuantum)
    broadcaster.flush()
}

// In this worker `self` is a DedicatedWorkerGlobalScope; the studio tsconfig types it as Window,
// hence the cast onto the Messenger's structural Port.
Communicator.executor<OfflineEngineProtocol>(
    Messenger.for(self as unknown as Parameters<typeof Messenger.for>[0]).channel("offline-engine"), {
        async initialize(enginePort: MessagePort, config: OfflineEngineInitializeConfig) {
            // User scripts read the `sampleRate` global (an AudioWorkletGlobalScope built-in); provide it
            // in this worker so the scriptable devices behave exactly as in the worklet.
            ;(globalThis as unknown as {sampleRate: number}).sampleRate = config.sampleRate
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
            // STEM export: hand the per-unit options to the engine BEFORE bind, in export order
            // ([uuid 16][flags u32 LE]: 1 includeAudioEffects, 2 includeSends, 4 useInstrumentOutput,
            // 8 skipChannelStrip) — the chain wiring consults them (TS builds units with AudioUnitOptions).
            const stems = config.exportConfiguration?.stems
            const stemKeys = isDefined(stems) ? Object.keys(stems) : []
            if (stemKeys.length > 0) {
                const recordsPtr = engine.input_reserve(stemKeys.length * 20)
                const view = new DataView(memory.buffer, recordsPtr, stemKeys.length * 20)
                stemKeys.forEach((key, index) => {
                    const stem = stems![key]
                    new Uint8Array(memory.buffer, recordsPtr + index * 20, 16).set(UUID.parse(key))
                    view.setUint32(index * 20 + 16,
                        (stem.includeAudioEffects ? 1 : 0) | (stem.includeSends ? 2 : 0)
                        | (stem.useInstrumentOutput ? 4 : 0) | ((stem.skipChannelStrip ?? false) ? 8 : 0), true)
                })
                engine.set_stem_export(stemKeys.length)
            }
            if (engine.bind() !== 0) {
                throw new Error("the project snapshot carries no TimelineBox")
            }
            const midi = new WasmMidiDrain()
            // Master telemetry over the SAME "engine-live-data" channel the realtime processor + TS
            // EngineProcessor use, so a live-stream consumer of an offline render (the video export's
            // shadertoy subscribes to SPECTRUM/WAVEFORM) receives data.
            const broadcaster = LiveStreamBroadcaster.create(messenger, "engine-live-data")
            const analyser = new AudioAnalyser()
            const spectrum = new Float32Array(analyser.numBins())
            const waveform = new Float32Array(analyser.numBins())
            const broadcasts: ReadonlyArray<Terminable> = [
                broadcaster.broadcastFloats(EngineAddresses.SPECTRUM, spectrum, (hasSubscribers) => {
                    if (!hasSubscribers) {return}
                    spectrum.set(analyser.bins())
                    analyser.decay = true
                }),
                broadcaster.broadcastFloats(EngineAddresses.WAVEFORM, waveform, (hasSubscribers) => {
                    if (!hasSubscribers) {return}
                    waveform.set(analyser.waveform())
                })
            ]
            const pending: Set<Promise<unknown>> = new Set()
            drainResourceRequests(engine, memory, engineToClient, pending, config.sampleRate,
                reason => engineToClient.error(describeEngineTrap(engine, memory, reason)))
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
                setupMIDI: (port: MessagePort, buffer: SharedArrayBuffer): void => midi.connect(port, buffer),
                terminate: (): void => {}
            })
            enginePort.start()
            state = Option.wrap({
                engine, memory, stateSender, pending, midi, broadcaster, analyser, broadcasts,
                sampleRate: config.sampleRate,
                numberOfChannels: stemKeys.length > 0 ? stemKeys.length * 2 : 2,
                stems: stemKeys.length,
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
            const {numberOfChannels, stems, midi, analyser, broadcaster} = state.unwrap("state.step")
            const result: Float32Array[] = Arrays.create(() => new Float32Array(numSamples), numberOfChannels)
            const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), numberOfChannels)
            let offset = 0 | 0
            while (offset < numSamples) {
                renderQuantum(engine, memory, outputChannels, stems, midi, analyser, broadcaster)
                const toCopy = Math.min(numSamples - offset, RenderQuantum)
                for (let channel = 0; channel < numberOfChannels; channel++) {
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
            const {numberOfChannels, stems} = state.unwrap("state.render")
            const chunks: Float32Array[][] = Arrays.create(() => [], numberOfChannels)
            let consecutiveSilentFrames = 0
            let hasHadAudio = false
            let lastYield = 0
            engine.running = true
            await Wait.timeSpan(TimeSpan.seconds(0))
            while (engine.running && engine.totalFrames < maxFrames) {
                const outputChannels: Float32Array[] = Arrays.create(() => new Float32Array(RenderQuantum), numberOfChannels)
                renderQuantum(engine.engine, engine.memory, outputChannels, stems, engine.midi, engine.analyser, engine.broadcaster)
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
                for (let channel = 0; channel < numberOfChannels; channel++) {
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
            }, numberOfChannels)
        },
        stop() { state.unwrap("state.stop").running = false }
    }
)

export {}
