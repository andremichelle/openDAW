// The WASM engine behind the STUDIO's engine contract: an AudioWorkletProcessor registered next to the TS
// "engine-processor" that consumes the same EngineProcessorAttachment and speaks the same message channels
// (engine-commands, engine-to-client, EngineState SyncStream, engine-live-data, engine-preferences) while
// rendering through the Rust engine + its device side-modules (linked exactly like the wasm app's worklet).
// Box-graph sync arrives pre-serialized over WASM_SYNC_CHANNEL (the main thread owns the source graph).
// Samples/soundfonts/NAM binaries are fetched through the UNCHANGED EngineToClient RPC and written into the
// engine's shared memory here. Recording, note signals, clip launching, monitoring and frozen audio are
// honest no-ops for now — the transport state simply never reports them active.
import "../../../wasm/src/worklet-scope" // MUST be first: shims `self`/`location` for inlined worker glue
import {int, isDefined, Nullable, panic, Provider, SyncStream, Terminable, Terminator, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioAnalyser, AudioData, ppqn, RenderQuantum} from "@opendaw/lib-dsp"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Address} from "@opendaw/lib-box"
import {LiveStreamBroadcaster} from "@opendaw/lib-fusion"
import {
    ClipSequencingUpdates,
    EngineAddresses,
    EngineCommands,
    EngineProcessorAttachment,
    EngineSettings,
    EngineSettingsSchema,
    EngineStateSchema,
    EngineToClient,
    MonitoringMapEntry,
    NoteSignal,
    PreferencesClient
} from "@opendaw/studio-adapters"
import type {SoundFont2} from "soundfont2"
import {PeakBroadcaster} from "../../../../studio/core-processors/src/PeakBroadcaster"
import {EngineExports} from "../../../wasm/src/engine-exports"
import {ScriptBridges, ScriptEngine} from "../../../wasm/src/script-bridge"
import {NamBridges} from "../../../wasm/src/nam-bridge"
import {linkDevice, registerComposite} from "../../../wasm/src/device-linker"
import {simplifySoundfont} from "../../../wasm/src/soundfont-simplify"
import {WASM_ENGINE_PROCESSOR_NAME, WASM_SYNC_CHANNEL, WasmEngineAttachment, WasmSyncProtocol} from "./protocol"

const ENGINE_TABLE_RESERVE = 512 // shared table slots reserved for the engine's own functions (it needs ~42)

class WasmEngineProcessor extends AudioWorkletProcessor {
    readonly #terminator: Terminator = new Terminator()
    readonly #memory: WebAssembly.Memory
    readonly #engine: EngineExports
    readonly #engineToClient: EngineToClient
    readonly #preferences: PreferencesClient<EngineSettings>
    readonly #stateSender: SyncStream.Writer
    readonly #controlFlags: Int32Array<SharedArrayBuffer>
    readonly #broadcaster: LiveStreamBroadcaster
    readonly #broadcastSubs: Array<Terminable> = []
    readonly #peaks: PeakBroadcaster
    readonly #analyser: AudioAnalyser
    readonly #pendingResources: Set<Promise<unknown>> = new Set()
    readonly #warned: Set<string> = new Set()

    #broadcastGeneration: int = -1
    #bound: boolean = false
    #valid: boolean = true
    #panic: boolean = false
    #transporting: boolean = false
    #playbackTimestamp: ppqn = 0.0 // this is where we start playing again (after paused)

    constructor({processorOptions}: {processorOptions: EngineProcessorAttachment} & AudioNodeOptions) {
        super()
        const {syncStreamBuffer, controlFlagsBuffer, variant} = processorOptions
        const {engineModule, deviceModules, deviceBoxTypes, composites, memory} = variant as WasmEngineAttachment
        this.#memory = memory
        const table = new WebAssembly.Table({initial: ENGINE_TABLE_RESERVE, element: "anyfunc"})
        const now: Provider<number> = isDefined(globalThis.performance)
            ? () => performance.now() * 1000.0 : () => Date.now() * 1000.0
        const engine = new WebAssembly.Instance(engineModule,
            {env: {memory, __indirect_function_table: table, host_perf_now: now}}).exports as unknown as EngineExports
        this.#engine = engine
        engine.init(sampleRate)
        const messenger = Messenger.for(this.port)
        this.#engineToClient = Communicator.sender<EngineToClient>(
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
                switchMarkerState(state: Nullable<[UUID.Bytes, int]>): void {
                    dispatcher.dispatchAndForget(this.switchMarkerState, state)
                }
                ready() {dispatcher.dispatchAndForget(this.ready)}
            })
        const scriptBridges = new ScriptBridges(memory, engine as unknown as ScriptEngine, sampleRate,
            (uuid, message) => this.#engineToClient.deviceMessage(uuid, message))
        const namBridges = new NamBridges(memory, () => this.#engineToClient.fetchNamWasm(), sampleRate)
        const bridgeImports = {...scriptBridges.imports(), ...namBridges.imports()}
        deviceModules.forEach((deviceModule, index) =>
            linkDevice(engine, memory, table, deviceModule, deviceBoxTypes[index], sampleRate, bridgeImports))
        composites.forEach(composite => registerComposite(engine, memory, composite))
        this.#controlFlags = new Int32Array<SharedArrayBuffer>(controlFlagsBuffer)
        this.#stateSender = SyncStream.writer(EngineStateSchema(), syncStreamBuffer, state => {
            const view = new DataView(this.#memory.buffer, engine.engine_state_ptr(), engine.engine_state_len())
            state.position = view.getFloat32(0)
            state.bpm = view.getFloat32(4)
            state.playbackTimestamp = this.#playbackTimestamp
            state.countInBeatsRemaining = 0
            state.isPlaying = view.getUint8(16) === 1
            state.isCountingIn = false
            state.isRecording = false
        })
        this.#broadcaster = this.#terminator.own(LiveStreamBroadcaster.create(messenger, "engine-live-data"))
        this.#peaks = this.#terminator.own(new PeakBroadcaster(this.#broadcaster, EngineAddresses.PEAKS))
        this.#analyser = new AudioAnalyser()
        const spectrum = new Float32Array(this.#analyser.numBins())
        const waveform = new Float32Array(this.#analyser.numBins())
        this.#preferences = new PreferencesClient(messenger.channel("engine-preferences"), EngineSettingsSchema.parse({}))
        this.#terminator.ownAll(
            this.#broadcaster.broadcastFloats(EngineAddresses.SPECTRUM, spectrum, (hasSubscribers) => {
                if (!hasSubscribers) {return}
                spectrum.set(this.#analyser.bins())
                this.#analyser.decay = true
            }),
            this.#broadcaster.broadcastFloats(EngineAddresses.WAVEFORM, waveform, (hasSubscribers) => {
                if (!hasSubscribers) {return}
                waveform.set(this.#analyser.waveform())
            }),
            this.#preferences.catchupAndSubscribe(enabled =>
                engine.set_metronome_enabled(enabled ? 1 : 0), "metronome", "enabled"),
            Communicator.executor<WasmSyncProtocol>(messenger.channel(WASM_SYNC_CHANNEL), {
                applyUpdates: (bytes: ArrayBuffer): void => this.#applyUpdates(bytes)
            }),
            Communicator.executor<EngineCommands>(messenger.channel("engine-commands"), {
                play: (): void => this.#play(),
                stop: (reset: boolean): void => this.#stop(reset),
                setPosition: (position: number): void => {
                    this.#playbackTimestamp = position
                    engine.set_position(position)
                },
                prepareRecordingState: (_countIn: boolean): void => this.#unsupported("recording"),
                stopRecording: (): void => {},
                queryLoadingComplete: (): Promise<boolean> =>
                    Promise.all(this.#pendingResources).then(() => true),
                panic: (): void => {this.#panic = true},
                loadClickSound: (_index: 0 | 1, _data: AudioData): void => {}, // the wasm engine ships its own click
                setFrozenAudio: (_uuid: UUID.Bytes, _audioData: Nullable<AudioData>): void => this.#unsupported("frozen audio"),
                updateMonitoringMap: (_map: ReadonlyArray<MonitoringMapEntry>): void => {},
                noteSignal: (signal: NoteSignal): void => this.#noteSignal(signal),
                ignoreNoteRegion: (_uuid: UUID.Bytes): void => {},
                scheduleClipPlay: (clipIds: ReadonlyArray<UUID.Bytes>): void => clipIds.forEach(uuid => {
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                    engine.schedule_clip_play()
                }),
                scheduleClipStop: (trackIds: ReadonlyArray<UUID.Bytes>): void => trackIds.forEach(uuid => {
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                    engine.schedule_clip_stop()
                }),
                setupMIDI: (_port: MessagePort, _buffer: SharedArrayBuffer): void => {},
                terminate: (): void => {
                    this.#valid = false
                    this.#broadcastSubs.forEach(subscription => subscription.terminate())
                    this.#broadcastSubs.length = 0
                    this.#terminator.terminate()
                }
            })
        )
        this.#engineToClient.ready()
    }

    process(_inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean {
        if (!this.#valid) {return false} // will not revive
        if (Atomics.load(this.#controlFlags, 0) === 1) {
            this.#stateSender.tryWrite() // keep the UI in sync (stopped transport) while asleep, no DSP
            return true
        }
        const {status, error} = tryCatch(() => this.#render(outputs))
        if (status === "failure") {
            console.debug(error)
            this.#valid = false
            this.#engineToClient.error(error)
            this.#terminator.terminate()
            return false
        }
        return true
    }

    #render([mainOutput]: Array<Array<Float32Array>>): void {
        if (this.#panic) {return panic("Manual Panic")}
        const engine = this.#engine
        engine.render()
        const frames = mainOutput[0].length // the render quantum (128)
        const buffer = this.#memory.buffer // re-read each block: talc may have grown the buffer
        const pointer = engine.output_ptr()
        const left = new Float32Array(buffer, pointer, frames)
        const right = new Float32Array(buffer, pointer + frames * Float32Array.BYTES_PER_ELEMENT, frames)
        mainOutput[0].set(left)
        if (mainOutput.length > 1) {mainOutput[1].set(right)}
        this.#peaks.process(mainOutput[0], mainOutput[1] ?? mainOutput[0])
        this.#analyser.process(mainOutput[0], mainOutput[1] ?? mainOutput[0], 0, RenderQuantum)
        this.#syncBroadcasts()
        this.#broadcaster.flush()
        this.#stateSender.tryWrite()
        this.#drainClipChanges()
    }

    // Forward the engine's queued clip transitions to the client (TS `clipSequencing.changes()` +
    // `notifyClipSequenceChanges`): 20-byte records [uuid 16][kind u32 LE].
    #drainClipChanges(): void {
        const engine = this.#engine
        const count = engine.clip_changes_count()
        if (count === 0) {return}
        const pointer = engine.input_reserve(count * 20)
        const taken = engine.clip_changes_take(pointer)
        const view = new DataView(this.#memory.buffer, pointer, taken * 20)
        const started: Array<UUID.Bytes> = []
        const stopped: Array<UUID.Bytes> = []
        const obsolete: Array<UUID.Bytes> = []
        for (let index = 0; index < taken; index++) {
            const uuid = new Uint8Array(this.#memory.buffer, pointer + index * 20, 16).slice() as UUID.Bytes
            const kind = view.getUint32(index * 20 + 16, true)
            if (kind === 0) {started.push(uuid)} else if (kind === 1) {stopped.push(uuid)} else {obsolete.push(uuid)}
        }
        this.#engineToClient.notifyClipSequenceChanges({started, stopped, obsolete})
    }

    // Route a live note signal (on-screen keys / pads / MIDI input) to the engine: the target
    // AudioUnitBox uuid goes into the input scratch, then the matching export fires.
    #noteSignal(signal: NoteSignal): void {
        const pointer = this.#engine.input_reserve(16)
        new Uint8Array(this.#memory.buffer, pointer, 16).set(signal.uuid)
        if (NoteSignal.isOn(signal)) {
            this.#engine.note_signal_on(signal.pitch, signal.velocity)
        } else if (NoteSignal.isOff(signal)) {
            this.#engine.note_signal_off(signal.pitch)
        } else if (NoteSignal.isAudition(signal)) {
            this.#engine.note_signal_audition(signal.pitch, signal.duration, signal.velocity)
        }
    }

    #play(): void {
        if (this.#preferences.settings.playback.timestampEnabled) {
            this.#engine.set_position(this.#playbackTimestamp)
        }
        this.#transporting = true
        this.#engine.play()
    }

    #stop(reset: boolean): void {
        // The engine can start transporting on its own (a clip launch), so consult ITS state too — the
        // local flag alone would misread a clip-launched playback as "not transporting" and hard-reset.
        const view = new DataView(this.#memory.buffer, this.#engine.engine_state_ptr(), this.#engine.engine_state_len())
        const wasTransporting = this.#transporting || view.getUint8(16) === 1
        this.#transporting = false
        this.#engine.pause()
        if (reset || !wasTransporting) {
            this.#engine.stop() // rewinds to 0 + resets every plugin (voices, tails, detectors)
            this.#playbackTimestamp = 0.0
            this.#peaks.clear()
        }
    }

    #applyUpdates(bytes: ArrayBuffer): void {
        const array = new Uint8Array(bytes)
        const pointer = this.#engine.input_reserve(array.length)
        new Uint8Array(this.#memory.buffer, pointer, array.length).set(array)
        const rejected = this.#engine.apply_updates(array.length)
        if (rejected !== 0) {
            // A rejected transaction permanently desyncs the engine's box-graph mirror: escalate as an engine
            // error so the studio's restart flow reboots the worklet from a fresh full dump.
            this.#engineToClient.error(new Error(`apply_updates rejected a transaction (code ${rejected})`))
            return
        }
        if (!this.#bound && this.#engine.bind() === 0) {this.#bound = true}
        // A transaction may have added AudioFileBoxes / SoundfontFileBox targets; dispatch their loads.
        this.#drainSampleRequests()
        this.#drainSoundfontRequests()
    }

    // Pop every sample the engine queued and run the load handshake for each: fetch + decode over the
    // unchanged EngineToClient RPC (the studio's sampleManager answers), write the planar frames into the
    // engine allocation, mark ready. The 16-byte uuid is copied out of the (reused) scratch BEFORE any await.
    #drainSampleRequests(): void {
        for (; ;) {
            const outPtr = this.#engine.input_reserve(16)
            const handle = this.#engine.sample_take_request(outPtr)
            if (handle < 0) {break}
            const uuid = new Uint8Array(this.#memory.buffer, outPtr, 16).slice() as UUID.Bytes
            this.#await(this.#engineToClient.fetchAudio(uuid).then(data => {
                const {numberOfFrames, numberOfChannels, sampleRate: dataRate, frames} = data
                const bytesPerChannel = numberOfFrames * Float32Array.BYTES_PER_ELEMENT
                const pointer = this.#engine.sample_allocate(handle, numberOfChannels * bytesPerChannel)
                for (let channel = 0; channel < numberOfChannels; channel++) {
                    new Float32Array(this.#memory.buffer, pointer + channel * bytesPerChannel, numberOfFrames)
                        .set(frames[channel])
                }
                this.#engine.sample_set_ready(handle, numberOfFrames, numberOfChannels, dataRate)
            }, (reason: unknown) => {
                // A failed fetch must never stick the load: mark the handle ready as a 1-frame silence.
                this.#engine.sample_allocate(handle, 4)
                this.#engine.sample_set_ready(handle, 1, 1, sampleRate)
                this.#engineToClient.log(`sample load failed: ${reason}`)
            }))
        }
    }

    // The soundfont analog: the parsed SoundFont2 arrives over the RPC (a structured clone, plain data),
    // the SIMPLIFIED blob is built here and written into the engine allocation.
    #drainSoundfontRequests(): void {
        for (; ;) {
            const outPtr = this.#engine.input_reserve(16)
            const handle = this.#engine.soundfont_take_request(outPtr)
            if (handle < 0) {break}
            const uuid = new Uint8Array(this.#memory.buffer, outPtr, 16).slice() as UUID.Bytes
            this.#await(this.#engineToClient.fetchSoundfont(uuid).then(soundfont => {
                const blob = new Uint8Array(simplifySoundfont(soundfont))
                const pointer = this.#engine.soundfont_allocate(handle, blob.byteLength)
                new Uint8Array(this.#memory.buffer, pointer, blob.byteLength).set(blob)
                this.#engine.soundfont_set_ready(handle)
            }, (reason: unknown) => this.#engineToClient.log(`soundfont load failed: ${reason}`)))
        }
    }

    #await(promise: Promise<unknown>): void {
        this.#pendingResources.add(promise)
        promise.finally(() => this.#pendingResources.delete(promise))
    }

    // Mirror the engine's broadcast table onto the LiveStreamBroadcaster whenever its generation moved (a
    // reconcile registered or swept telemetry slots): terminate every stale package, then register each entry
    // as a package whose Float32Array view points straight into wasm memory — the broadcaster reads the LIVE
    // values at flush, so the render path never copies.
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
            const pointer = record.getUint32(20, true)
            const length = record.getUint32(24, true)
            const keysCount = record.getUint32(28, true)
            const keys: Array<number> = []
            for (let position = 0; position < keysCount; position++) {
                keys.push(record.getUint16(32 + position * 2, true))
            }
            const address = Address.compose(uuid, ...keys)
            const values = new Float32Array(this.#memory.buffer, pointer, length)
            if (packageType === 0) { // PackageType.Float
                this.#broadcastSubs.push(this.#broadcaster.broadcastFloat(address, () => values[0]))
            } else { // PackageType.FloatArray
                this.#broadcastSubs.push(this.#broadcaster.broadcastFloats(address, values,
                    hasSubscribers => this.#engine.broadcast_set_active(index, hasSubscribers ? 1 : 0)))
            }
        }
    }

    #unsupported(feature: string): void {
        if (this.#warned.has(feature)) {return}
        this.#warned.add(feature)
        this.#engineToClient.log(`WASM engine: ${feature} not supported yet`)
    }
}

registerProcessor(WASM_ENGINE_PROCESSOR_NAME, WasmEngineProcessor)

export {} // isolate this file's module scope from other worklets
