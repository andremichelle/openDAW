// The WASM engine behind the STUDIO's engine contract: an AudioWorkletProcessor registered next to the TS
// "engine-processor" that consumes the same EngineProcessorAttachment and speaks the same message channels
// (engine-commands, engine-to-client, EngineState SyncStream, engine-live-data, engine-preferences) while
// rendering through the Rust engine + its device side-modules (linked exactly like the wasm app's worklet).
// Box-graph sync arrives pre-serialized over WASM_SYNC_CHANNEL (the main thread owns the source graph).
// Samples/soundfonts/NAM binaries are fetched through the UNCHANGED EngineToClient RPC and written into the
// engine's shared memory here. Recording, note signals, clip launching, monitoring and frozen audio are
// honest no-ops for now — the transport state simply never reports them active.
import "./worklet-scope" // MUST be first: shims `self`/`location` for inlined worker glue
import {Exec, int, Nullable, panic, SyncStream, Terminable, Terminator, tryCatch, UUID} from "@opendaw/lib-std"
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
    PERF_BUFFER_SIZE,
    EngineToClient,
    MonitoringMapEntry,
    NoteSignal,
    PreferencesClient
} from "@opendaw/studio-adapters"
import type {SoundFont2} from "soundfont2"
import {HRClock} from "../../core-processors/src/HRClock"
import {PeakBroadcaster} from "../../core-processors/src/PeakBroadcaster"
import {GonioCapture, LoudnessMeter, StereoAnalyser} from "./analysis-dsp"
import {EngineExports} from "./engine-exports"
import {WasmMidiDrain} from "./midi-drain"
import {describeEngineTrap, drainResourceRequests, instantiateWasmEngine} from "./boot"
import {
    WASM_ENGINE_PROCESSOR_NAME,
    WASM_FROZEN_CHANNEL,
    WASM_SYNC_CHANNEL,
    WasmEngineAttachment,
    WasmFrozenProtocol,
    WasmSyncProtocol
} from "./protocol"

const GONIO_PAIRS = 512

class WasmEngineProcessor extends AudioWorkletProcessor {
    readonly #terminator: Terminator = new Terminator()
    readonly #memory: WebAssembly.Memory
    readonly #engine: EngineExports
    readonly #hrClock: HRClock
    readonly #perfBuffer: Float32Array = new Float32Array(PERF_BUFFER_SIZE)
    readonly #engineToClient: EngineToClient
    readonly #preferences: PreferencesClient<EngineSettings>
    readonly #stateSender: SyncStream.Writer
    readonly #controlFlags: Int32Array<SharedArrayBuffer>
    readonly #broadcaster: LiveStreamBroadcaster
    readonly #broadcastSubs: Array<Terminable> = []
    readonly #peaks: PeakBroadcaster
    readonly #analyser: AudioAnalyser
    readonly #stereo: StereoAnalyser = new StereoAnalyser()
    readonly #gonio: GonioCapture = new GonioCapture(GONIO_PAIRS)
    readonly #loudness: LoudnessMeter = new LoudnessMeter(sampleRate)
    readonly #stereoValues: Float32Array = new Float32Array(5)
    readonly #gonioValues: Float32Array = new Float32Array(GONIO_PAIRS * 2)
    readonly #loudnessValues: Float32Array = new Float32Array(5)
    #spectrumActive: boolean = false
    #waveformActive: boolean = false
    #stereoActive: boolean = false
    #gonioActive: boolean = false
    #loudnessActive: boolean = false
    readonly #midi: WasmMidiDrain = new WasmMidiDrain()
    readonly #pendingResources: Set<Promise<unknown>> = new Set()

    #broadcastGeneration: int = -1
    #monitoringMap: ReadonlyArray<MonitoringMapEntry> = []
    #bound: boolean = false
    #valid: boolean = true
    #panic: boolean = false
    #transporting: boolean = false
    #measureLoad: boolean = false // debug.dspLoadMeasurement (TS EngineProcessor.render's measureLoad)
    #perfWriteIndex: int = 0
    #playbackTimestamp: ppqn = 0.0 // this is where we start playing again (after paused)

    constructor({processorOptions}: {processorOptions: EngineProcessorAttachment} & AudioNodeOptions) {
        super()
        const {syncStreamBuffer, controlFlagsBuffer, hrClockBuffer, variant} = processorOptions
        const {engineModule, deviceModules, deviceBoxTypes, composites, effectComposites, memory} = variant as WasmEngineAttachment
        this.#memory = memory
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
        const engine = instantiateWasmEngine({engineModule, deviceModules, deviceBoxTypes, composites, effectComposites},
            memory, sampleRate, this.#engineToClient)
        this.#engine = engine
        this.#controlFlags = new Int32Array<SharedArrayBuffer>(controlFlagsBuffer)
        this.#hrClock = new HRClock(hrClockBuffer)
        this.#stateSender = SyncStream.writer(EngineStateSchema(), syncStreamBuffer, state => {
            const view = new DataView(this.#memory.buffer, engine.engine_state_ptr(), engine.engine_state_len())
            state.position = view.getFloat32(0)
            state.bpm = view.getFloat32(4)
            state.playbackTimestamp = this.#playbackTimestamp
            state.countInBeatsRemaining = view.getFloat32(12)
            state.isPlaying = view.getUint8(16) === 1
            state.isCountingIn = view.getUint8(17) === 1
            state.isRecording = view.getUint8(18) === 1
            if (this.#measureLoad) {
                state.perfBuffer.set(this.#perfBuffer)
                state.perfIndex = this.#perfWriteIndex
            }
        })
        this.#broadcaster = this.#terminator.own(LiveStreamBroadcaster.create(messenger, "engine-live-data"))
        this.#peaks = this.#terminator.own(new PeakBroadcaster(this.#broadcaster, EngineAddresses.PEAKS))
        this.#analyser = new AudioAnalyser()
        const spectrum = new Float32Array(this.#analyser.numBins())
        const waveform = new Float32Array(this.#analyser.numBins())
        this.#preferences = new PreferencesClient(messenger.channel("engine-preferences"), EngineSettingsSchema.parse({}))
        this.#terminator.ownAll(
            this.#broadcaster.broadcastFloats(EngineAddresses.SPECTRUM, spectrum, (hasSubscribers) => {
                this.#spectrumActive = hasSubscribers
                if (!hasSubscribers) {return}
                spectrum.set(this.#analyser.bins())
                this.#analyser.decay = true
            }),
            this.#broadcaster.broadcastFloats(EngineAddresses.WAVEFORM, waveform, (hasSubscribers) => {
                this.#waveformActive = hasSubscribers
                if (!hasSubscribers) {return}
                waveform.set(this.#analyser.waveform())
            }),
            this.#broadcaster.broadcastFloats(EngineAddresses.STEREO, this.#stereoValues,
                (hasSubscribers) => {this.#stereoActive = hasSubscribers}),
            this.#broadcaster.broadcastFloats(EngineAddresses.GONIO, this.#gonioValues,
                (hasSubscribers) => {this.#gonioActive = hasSubscribers}),
            this.#broadcaster.broadcastFloats(EngineAddresses.LOUDNESS, this.#loudnessValues,
                (hasSubscribers) => {
                    this.#loudnessActive = hasSubscribers
                    if (hasSubscribers) {this.#loudness.fill(this.#loudnessValues)}
                }),
            this.#preferences.catchupAndSubscribe(enabled =>
                engine.set_metronome_enabled(enabled ? 1 : 0), "metronome", "enabled"),
            this.#preferences.catchupAndSubscribe(gain =>
                engine.set_metronome_gain(gain), "metronome", "gain"),
            this.#preferences.catchupAndSubscribe(division =>
                engine.set_metronome_beat_sub_division(division), "metronome", "beatSubDivision"),
            this.#preferences.catchupAndSubscribe(monophonic =>
                engine.set_metronome_monophonic(monophonic ? 1 : 0), "metronome", "monophonic"),
            this.#preferences.catchupAndSubscribe(allowTakes =>
                engine.set_allow_takes(allowTakes ? 1 : 0), "recording", "allowTakes"),
            this.#preferences.catchupAndSubscribe(pauseOnLoopDisabled =>
                engine.set_pause_on_loop_disabled(pauseOnLoopDisabled ? 1 : 0), "playback", "pauseOnLoopDisabled"),
            this.#preferences.catchupAndSubscribe(truncate =>
                engine.set_truncate_notes_at_region_end(truncate ? 1 : 0), "playback", "truncateNotesAtRegionEnd"),
            this.#preferences.catchupAndSubscribe(measure =>
                this.#measureLoad = measure, "debug", "dspLoadMeasurement"),
            Communicator.executor<WasmSyncProtocol>(messenger.channel(WASM_SYNC_CHANNEL), {
                applyUpdates: (bytes: ArrayBuffer): void => this.#guarded(() => this.#applyUpdates(bytes)),
                checksum: (bytes: Int8Array): Promise<void> => this.#verifyChecksum(bytes)
            }),
            // Freeze PCM delivery (WasmEngine.connectFrozenAudio): the MAIN thread writes the frames into
            // the shared memory between allocate and attach — nothing here copies sample data.
            Communicator.executor<WasmFrozenProtocol>(messenger.channel(WASM_FROZEN_CHANNEL), {
                frozenAllocate: (frameCount: number, channels: number): Promise<number> => {
                    const {status, value, error} = tryCatch(() => engine.frozen_allocate(frameCount, channels))
                    if (status === "failure") {
                        this.#fail(error)
                        return Promise.reject(error)
                    }
                    return Promise.resolve(value)
                },
                frozenAttach: (uuid: UUID.Bytes, frameCount: number, channels: number, sampleRate: number): void =>
                    this.#guarded(() => {
                        const pointer = engine.input_reserve(16)
                        new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                        engine.set_frozen_audio(frameCount, channels, sampleRate)
                    }),
                frozenClear: (uuid: UUID.Bytes): void => this.#guarded(() => {
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                    engine.clear_frozen_audio()
                })
            }),
            Communicator.executor<EngineCommands>(messenger.channel("engine-commands"), {
                play: (): void => this.#guarded(() => this.#play()),
                stop: (reset: boolean): void => this.#guarded(() => this.#stop(reset)),
                setPosition: (position: number): void => this.#guarded(() => {
                    this.#playbackTimestamp = position
                    engine.set_position(position)
                }),
                prepareRecordingState: (countIn: boolean): void => this.#guarded(() => {
                    this.#transporting = true
                    engine.prepare_recording_state(countIn ? 1 : 0,
                        this.#preferences.settings.recording.countInBars)
                }),
                stopRecording: (): void => this.#guarded(() => {
                    this.#transporting = false
                    engine.stop_recording()
                }),
                queryLoadingComplete: (): Promise<boolean> =>
                    Promise.all(this.#pendingResources).then(() => true),
                panic: (): void => {this.#panic = true},
                loadClickSound: (index: 0 | 1, data: AudioData): void => this.#guarded(() => {
                    // Tiny PCM (<1s), so the worklet copies it directly (no main-thread staging like frozen).
                    const {frames, numberOfFrames, numberOfChannels, sampleRate} = data
                    const channels = Math.min(numberOfChannels, 2)
                    const pcm = engine.click_allocate(numberOfFrames, channels)
                    for (let channel = 0; channel < channels; channel++) {
                        new Float32Array(this.#memory.buffer, pcm + channel * numberOfFrames * 4, numberOfFrames)
                            .set(frames[channel])
                    }
                    engine.set_click_sound(index, numberOfFrames, channels, sampleRate)
                }),
                setFrozenAudio: (uuid: UUID.Bytes, audioData: Nullable<AudioData>): void => this.#guarded(() => {
                    if (audioData === null) {
                        const pointer = engine.input_reserve(16)
                        new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                        engine.clear_frozen_audio()
                        return
                    }
                    const {frames, numberOfFrames, numberOfChannels, sampleRate} = audioData
                    const channels = Math.min(numberOfChannels, 2)
                    const pcm = engine.frozen_allocate(numberOfFrames, channels)
                    if (pcm === 0) {return} // no engine instance: writing at 0 would corrupt memory (see boot.ts)
                    for (let channel = 0; channel < channels; channel++) {
                        new Float32Array(this.#memory.buffer, pcm + channel * numberOfFrames * 4, numberOfFrames)
                            .set(frames[channel])
                    }
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                    engine.set_frozen_audio(numberOfFrames, channels, sampleRate)
                }),
                updateMonitoringMap: (map: ReadonlyArray<MonitoringMapEntry>): void => this.#guarded(() => {
                    // [uuid 16][left i32 LE][right i32 LE] per entry; -1 right = mono source.
                    this.#monitoringMap = map
                    const pointer = engine.input_reserve(map.length * 24)
                    const view = new DataView(this.#memory.buffer, pointer, map.length * 24)
                    map.forEach(({uuid, channels}, index) => {
                        new Uint8Array(this.#memory.buffer, pointer + index * 24, 16).set(uuid)
                        view.setInt32(index * 24 + 16, channels[0], true)
                        view.setInt32(index * 24 + 20, channels.length > 1 ? channels[1] : -1, true)
                    })
                    engine.set_monitoring_map(map.length)
                }),
                noteSignal: (signal: NoteSignal): void => this.#guarded(() => this.#noteSignal(signal)),
                ignoreNoteRegion: (uuid: UUID.Bytes): void => this.#guarded(() => {
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                    engine.ignore_note_region()
                }),
                scheduleClipPlay: (clipIds: ReadonlyArray<UUID.Bytes>): void => this.#guarded(() => clipIds.forEach(uuid => {
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                    engine.schedule_clip_play()
                })),
                scheduleClipStop: (trackIds: ReadonlyArray<UUID.Bytes>): void => this.#guarded(() => trackIds.forEach(uuid => {
                    const pointer = engine.input_reserve(16)
                    new Uint8Array(this.#memory.buffer, pointer, 16).set(uuid)
                    engine.schedule_clip_stop()
                })),
                // The TS EngineProcessor contract: the main thread's MIDIReceiver hands over its port +
                // SAB ring; the engine's drained MIDI records feed the same MIDISender transport.
                setupMIDI: (port: MessagePort, buffer: SharedArrayBuffer): void => this.#midi.connect(port, buffer),
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

    process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean {
        if (!this.#valid) {return false} // will not revive
        if (Atomics.load(this.#controlFlags, 0) === 1) {
            this.#stateSender.tryWrite() // keep the UI in sync (stopped transport) while asleep, no DSP
            return true
        }
        const {status, error} = tryCatch(() => this.#render(inputs, outputs))
        if (status === "failure") {
            this.#fail(error)
            return false
        }
        return true
    }

    // A failure in a command handler (usually an engine trap) leaves the wasm instance unusable AND would
    // otherwise escape uncaught in the AudioWorkletGlobalScope: invalidate the processor and escalate through
    // engineToClient.error (with the wasm panic message attached) so the studio's restart flow reboots.
    #fail(error: unknown): void {
        console.debug(error)
        this.#valid = false
        this.#engineToClient.error(describeEngineTrap(this.#engine, this.#memory, error))
        this.#terminator.terminate()
    }

    #guarded(exec: Exec): void {
        const {status, error} = tryCatch(exec)
        if (status === "failure") {this.#fail(error)}
    }

    // The engine refreshes a rolling 32-byte checksum after every applied transaction; the main thread sends
    // the source graph's checksum through the same ordered channel, so equality proves the mirror still
    // tracks the source. A divergence permanently desyncs playback: escalate so the studio's restart flow
    // reboots from a fresh full dump.
    #verifyChecksum(bytes: Int8Array): Promise<void> {
        const local = new Int8Array(this.#memory.buffer, this.#engine.checksum_ptr(), 32)
        if (bytes.length === local.length && bytes.every((byte, index) => byte === local[index])) {
            return Promise.resolve()
        }
        const error = new Error("box-graph checksum mismatch: the engine mirror diverged from the source graph")
        this.#engineToClient.error(error)
        return Promise.reject(error)
    }

    #render(inputs: Array<Array<Float32Array>>, [mainOutput, monitorOutput]: Array<Array<Float32Array>>): void {
        if (this.#panic) {return panic("Manual Panic")}
        // DSP-load measurement (TS EngineProcessor.render): start() returns the PREVIOUS quantum's
        // validated elapsed time; end() signals the HRClock worker for this one.
        const elapsed = this.#measureLoad ? this.#hrClock.start() : 0
        const engine = this.#engine
        // EFFECTS monitoring: stage the live input channels for the in-chain injectors, render, then hand
        // each mapped unit's strip output back on the 2nd worklet output (the MonitoringRouter return).
        const monitoring = this.#monitoringMap
        if (monitoring.length > 0) {
            const input = inputs[0] ?? []
            const staging = new Float32Array(this.#memory.buffer, engine.monitor_input_ptr(), 8 * RenderQuantum)
            staging.fill(0.0)
            for (const {channels} of monitoring) {
                for (const channel of channels) {
                    const source = input[channel]
                    if (source !== undefined && channel < 8) {staging.set(source, channel * RenderQuantum)}
                }
            }
        }
        engine.render()
        if (monitoring.length > 0 && monitorOutput !== undefined) {
            const staged = new Float32Array(this.#memory.buffer, engine.monitor_output_ptr(), 8 * RenderQuantum)
            for (const {channels} of monitoring) {
                for (const channel of channels) {
                    const target = monitorOutput[channel]
                    if (target !== undefined && channel < 8) {target.set(staged.subarray(channel * RenderQuantum, (channel + 1) * RenderQuantum))}
                }
            }
        }
        const frames = mainOutput[0].length // the render quantum (128)
        const buffer = this.#memory.buffer // re-read each block: talc may have grown the buffer
        const pointer = engine.output_ptr()
        const left = new Float32Array(buffer, pointer, frames)
        const right = new Float32Array(buffer, pointer + frames * Float32Array.BYTES_PER_ELEMENT, frames)
        mainOutput[0].set(left)
        if (mainOutput.length > 1) {mainOutput[1].set(right)}
        const chLeft = mainOutput[0]
        const chRight = mainOutput[1] ?? mainOutput[0]
        this.#peaks.process(chLeft, chRight)
        if (this.#spectrumActive || this.#waveformActive) {
            this.#analyser.process(chLeft, chRight, 0, RenderQuantum)
        }
        if (this.#stereoActive) {this.#stereo.process(chLeft, chRight, this.#stereoValues)}
        if (this.#gonioActive) {this.#gonio.process(chLeft, chRight, this.#gonioValues)}
        if (this.#loudnessActive) {this.#loudness.process(chLeft, chRight)}
        this.#syncBroadcasts()
        if (this.#measureLoad) {
            this.#hrClock.end()
            this.#perfBuffer[this.#perfWriteIndex] = elapsed
            this.#perfWriteIndex = (this.#perfWriteIndex + 1) % PERF_BUFFER_SIZE
        }
        this.#broadcaster.flush()
        this.#stateSender.tryWrite()
        this.#drainClipChanges()
        this.#drainMarkerChanges()
        this.#midi.drain(engine, this.#memory)
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

    // Forward the engine's queued marker-state changes to the client (TS BlockRenderer's
    // `switchMarkerState([uuid, count] | null)`): 24-byte records [uuid 16][count u32 LE][flag u32 LE].
    #drainMarkerChanges(): void {
        const engine = this.#engine
        const count = engine.marker_changes_count()
        if (count === 0) {return}
        const pointer = engine.input_reserve(count * 24)
        const taken = engine.marker_changes_take(pointer)
        const view = new DataView(this.#memory.buffer, pointer, taken * 24)
        for (let index = 0; index < taken; index++) {
            const active = view.getUint32(index * 24 + 20, true) === 1
            if (active) {
                const uuid = new Uint8Array(this.#memory.buffer, pointer + index * 24, 16).slice() as UUID.Bytes
                this.#engineToClient.switchMarkerState([uuid, view.getUint32(index * 24 + 16, true)])
            } else {
                this.#engineToClient.switchMarkerState(null)
            }
        }
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
        const wasRecording = view.getUint8(17) === 1 || view.getUint8(18) === 1
        this.#transporting = false
        this.#engine.pause()
        if (wasRecording) {
            // TS `#stop`: leaving a recording returns the playhead to where playback started (or 0).
            this.#engine.set_position(this.#preferences.settings.playback.timestampEnabled ? this.#playbackTimestamp : 0.0)
        }
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
        drainResourceRequests(this.#engine, this.#memory, this.#engineToClient, this.#pendingResources,
            sampleRate, error => this.#fail(error))
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
            if (packageType === 0) { // PackageType.Float
                const values = new Float32Array(this.#memory.buffer, pointer, length)
                this.#broadcastSubs.push(this.#broadcaster.broadcastFloat(address, () => values[0]))
            } else if (packageType === 2) { // INT RING: [0] = the device's write index, [1..] = i32 payloads
                const ints = new Int32Array(this.#memory.buffer, pointer, length)
                const ring = new Int32Array(this.#memory.buffer, pointer + 4, length - 1)
                this.#broadcastSubs.push(this.#broadcaster.broadcastIntegers(address, ring, () => {
                    // Consume-on-read (TS Velocity: sentinel at the write index, then reset).
                    ring[Math.min(ints[0], ring.length - 1)] = 0
                    ints[0] = 0
                }))
            } else if (packageType === 3) { // INT ARRAY: a plain i32 mirror (e.g. the unit's note bits)
                const ints = new Int32Array(this.#memory.buffer, pointer, length)
                this.#broadcastSubs.push(this.#broadcaster.broadcastIntegers(address, ints, () => {}))
            } else { // PackageType.FloatArray
                const values = new Float32Array(this.#memory.buffer, pointer, length)
                this.#broadcastSubs.push(this.#broadcaster.broadcastFloats(address, values,
                    hasSubscribers => this.#engine.broadcast_set_active(index, hasSubscribers ? 1 : 0)))
            }
        }
    }

}

registerProcessor(WASM_ENGINE_PROCESSOR_NAME, WasmEngineProcessor)

export {} // isolate this file's module scope from other worklets
