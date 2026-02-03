import {
    Arrays,
    DefaultObservableValue,
    int,
    MutableObservableValue,
    Notifier,
    Nullable,
    ObservableValue,
    Observer,
    Option,
    Subscription,
    SyncStream,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {AudioData, bpm, ppqn, RenderQuantum} from "@opendaw/lib-dsp"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {
    ClipNotification,
    ClipSequencingUpdates,
    EngineCommands,
    EngineProcessorAttachment,
    EngineSettings,
    EngineSettingsSchema,
    EngineState,
    EngineStateSchema,
    EngineToClient,
    ExportStemsConfiguration,
    NoteSignal,
    PERF_BUFFER_SIZE,
    PreferencesHost,
    ProcessorOptions
} from "@opendaw/studio-adapters"
import {SyncSource} from "@opendaw/lib-box"
import {AnimationFrame} from "@opendaw/lib-dom"
import {BoxIO} from "@opendaw/studio-boxes"
import {Engine} from "./Engine"
import {Project} from "./project"
import {MIDIReceiver} from "./midi"
import {HRClockWorker} from "./HRClockWorker"
import type {SoundFont2} from "soundfont2"

export class EngineWorklet extends AudioWorkletNode implements Engine {
    static ID: int = 0 | 0

    readonly id = EngineWorklet.ID++

    readonly #terminator: Terminator = new Terminator()

    readonly #project: Project
    readonly #playbackTimestamp: DefaultObservableValue<ppqn> = new DefaultObservableValue(0.0)
    readonly #position: DefaultObservableValue<ppqn> = new DefaultObservableValue(0.0)
    readonly #bpm: DefaultObservableValue<bpm> = new DefaultObservableValue(120.0)
    readonly #isPlaying: DefaultObservableValue<boolean> = new DefaultObservableValue(false)
    readonly #isRecording: DefaultObservableValue<boolean> = new DefaultObservableValue(false)
    readonly #isCountingIn: DefaultObservableValue<boolean> = new DefaultObservableValue(false)
    readonly #countInBeatsRemaining: DefaultObservableValue<int> = new DefaultObservableValue(0)
    readonly #preferences: PreferencesHost<EngineSettings>
    readonly #markerState: DefaultObservableValue<Nullable<[UUID.Bytes, int]>> =
        new DefaultObservableValue<Nullable<[UUID.Bytes, int]>>(null)
    readonly #cpuLoad: DefaultObservableValue<number> = new DefaultObservableValue(0)
    readonly #controlFlags: Int32Array<SharedArrayBuffer>
    readonly #notifyClipNotification: Notifier<ClipNotification>
    readonly #notifyNoteSignals: Notifier<NoteSignal>
    readonly #playingClips: Array<UUID.Bytes>
    readonly #commands: EngineCommands
    readonly #isReady: Promise<void>

    #perfBuffer: Float32Array = new Float32Array(0)
    #perfIndex: number = 0

    constructor(context: BaseAudioContext,
                project: Project,
                exportConfiguration?: ExportStemsConfiguration,
                options?: ProcessorOptions) {
        const numberOfChannels = ExportStemsConfiguration.countStems(Option.wrap(exportConfiguration)) * 2
        const budgetMs = (RenderQuantum / context.sampleRate) * 1000
        let lastPerfReadIndex = 0
        let consecutiveOverloadCount = 0
        let lastCpuLoadUpdate = 0
        let maxMsSinceLastUpdate = 0
        const reader = SyncStream.reader<EngineState>(EngineStateSchema(), state => {
            this.#isPlaying.setValue(state.isPlaying)
            this.#isRecording.setValue(state.isRecording)
            this.#isCountingIn.setValue(state.isCountingIn)
            this.#countInBeatsRemaining.setValue(state.countInBeatsRemaining)
            this.#playbackTimestamp.setValue(state.playbackTimestamp)
            this.#bpm.setValue(state.bpm)
            this.#perfBuffer = state.perfBuffer
            this.#perfIndex = state.perfIndex
            let readIndex = lastPerfReadIndex
            while (readIndex !== this.#perfIndex) {
                const ms = this.#perfBuffer[readIndex]
                if (ms > maxMsSinceLastUpdate) {maxMsSinceLastUpdate = ms}
                if (ms >= budgetMs) {
                    consecutiveOverloadCount++
                    if (consecutiveOverloadCount >= 30) {
                        project.handleCpuOverload()
                        consecutiveOverloadCount = 0
                    }
                } else {
                    consecutiveOverloadCount = 0
                }
                readIndex = (readIndex + 1) % PERF_BUFFER_SIZE
            }
            lastPerfReadIndex = readIndex
            const now = performance.now()
            if (now - lastCpuLoadUpdate >= 1000) {
                this.#cpuLoad.setValue(Math.round((maxMsSinceLastUpdate / budgetMs) * 100))
                maxMsSinceLastUpdate = 0
                lastCpuLoadUpdate = now
            }
            this.#position.setValue(state.position) // This must be the last to handle the state values before
        })

        const controlFlagsSAB = new SharedArrayBuffer(4) // 4 bytes minimum

        super(context, "engine-processor", {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [numberOfChannels],
                processorOptions: {
                    syncStreamBuffer: reader.buffer,
                    controlFlagsBuffer: controlFlagsSAB,
                    hrClockBuffer: HRClockWorker.get().sab,
                    project: project.toArrayBuffer(),
                    exportConfiguration,
                    options
                } satisfies EngineProcessorAttachment
            }
        )

        const {resolve, promise: isReady} = Promise.withResolvers<void>()
        const messenger = Messenger.for(this.port)
        this.#project = project
        this.#isReady = isReady
        this.#notifyClipNotification = this.#terminator.own(new Notifier<ClipNotification>())
        this.#notifyNoteSignals = this.#terminator.own(new Notifier<NoteSignal>())
        this.#playingClips = []
        this.#controlFlags = new Int32Array(controlFlagsSAB)
        this.#commands = this.#terminator.own(
            Communicator.sender<EngineCommands>(messenger.channel("engine-commands"),
                dispatcher => new class implements EngineCommands {
                    play(): void {dispatcher.dispatchAndForget(this.play)}
                    stop(reset: boolean): void {dispatcher.dispatchAndForget(this.stop, reset)}
                    setPosition(position: number): void {dispatcher.dispatchAndForget(this.setPosition, position)}
                    prepareRecordingState(countIn: boolean) {
                        dispatcher.dispatchAndForget(this.prepareRecordingState, countIn)
                    }
                    stopRecording() {dispatcher.dispatchAndForget(this.stopRecording)}
                    queryLoadingComplete(): Promise<boolean> {
                        return dispatcher.dispatchAndReturn(this.queryLoadingComplete)
                    }
                    panic(): void {dispatcher.dispatchAndForget(this.panic)}
                    sleep(): void {dispatcher.dispatchAndForget(this.sleep)}
                    wake(): void {dispatcher.dispatchAndForget(this.wake)}
                    loadClickSound(index: 0 | 1, data: AudioData): void {
                        dispatcher.dispatchAndForget(this.loadClickSound, index, data)
                    }
                    noteSignal(signal: NoteSignal): void {dispatcher.dispatchAndForget(this.noteSignal, signal)}
                    ignoreNoteRegion(uuid: UUID.Bytes): void {
                        dispatcher.dispatchAndForget(this.ignoreNoteRegion, uuid)
                    }
                    scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void {
                        dispatcher.dispatchAndForget(this.scheduleClipPlay, clipIds)
                    }
                    scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void {
                        dispatcher.dispatchAndForget(this.scheduleClipStop, trackIds)
                    }
                    setupMIDI(port: MessagePort, buffer: SharedArrayBuffer) {
                        dispatcher.dispatchAndForget(this.setupMIDI, port, buffer)
                    }
                    terminate(): void {dispatcher.dispatchAndForget(this.terminate)}
                }))

        const {port, sab} =
            this.#terminator.own(MIDIReceiver.create(
                () => context instanceof AudioContext ? context.outputLatency * 1000 : 20,
                (deviceId, data, relativeTimeInMs) =>
                    this.#project.receivedMIDIFromEngine(deviceId, data, relativeTimeInMs)))
        this.#commands.setupMIDI(port, sab)
        Communicator.executor<EngineToClient>(messenger.channel("engine-to-client"), {
                log: (message: string): void => console.log("WORKLET", message),
                error: (reason: unknown) => this.dispatchEvent(new ErrorEvent("error", {error: reason})),
                ready: (): void => resolve(),
                fetchAudio: (uuid: UUID.Bytes): Promise<AudioData> => {
                    return new Promise((resolve, reject) => {
                        const handler = project.sampleManager.getOrCreate(uuid)
                        const subscription = handler.subscribe(state => {
                            if (state.type === "error") {
                                reject(new Error(state.reason))
                                subscription.terminate()
                            } else if (state.type === "loaded") {
                                resolve(handler.data.unwrap())
                                subscription.terminate()
                            }
                        })
                    })
                },
                fetchSoundfont: (uuid: UUID.Bytes): Promise<SoundFont2> => {
                    return new Promise((resolve, reject) => {
                        const handler = project.soundfontManager.getOrCreate(uuid)
                        const subscription = handler.subscribe(state => {
                            if (state.type === "error") {
                                reject(new Error(state.reason))
                                subscription.terminate()
                            } else if (state.type === "loaded") {
                                resolve(handler.soundfont.unwrap())
                                subscription.terminate()
                            }
                        })
                    })
                },
                fetchNamWasm: async (): Promise<ArrayBuffer> => {
                    const url = new URL("@opendaw/nam-wasm/nam.wasm", import.meta.url)
                    const response = await fetch(url)
                    return response.arrayBuffer()
                },
                notifyClipSequenceChanges: (changes: ClipSequencingUpdates): void => {
                    changes.stopped.forEach(uuid => {
                        for (let i = 0; i < this.#playingClips.length; i++) {
                            if (UUID.equals(this.#playingClips[i], uuid)) {
                                this.#playingClips.splice(i, 1)
                                break
                            }
                        }
                    })
                    changes.started.forEach(uuid => this.#playingClips.push(uuid))
                    this.#notifyClipNotification.notify({type: "sequencing", changes})
                },
                switchMarkerState: (state: Nullable<[UUID.Bytes, int]>): void => this.#markerState.setValue(state)
            } satisfies EngineToClient
        )
        this.#preferences = this.#terminator.own(new PreferencesHost<EngineSettings>(EngineSettingsSchema.parse({})))
        this.#terminator.ownAll(
            AnimationFrame.add(() => reader.tryRead()),
            project.liveStreamReceiver.connect(messenger.channel("engine-live-data")),
            this.#preferences.syncWith(messenger.channel("engine-preferences")),
            new SyncSource<BoxIO.TypeMap>(project.boxGraph, messenger.channel("engine-sync"), false)
        )
    }

    play(): void {
        this.wake()
        this.#commands.play()
    }
    stop(reset: boolean = false): void {
        this.#isPlaying.setValue(false)
        this.#commands.stop(reset)
    }
    setPosition(position: ppqn): void {this.#commands.setPosition(position)}
    prepareRecordingState(countIn: boolean): void {this.#commands.prepareRecordingState(countIn)}
    stopRecording(): void {this.#commands.stopRecording()}
    panic(): void {this.#commands.panic()}
    sleep(): void {
        Atomics.store(this.#controlFlags, 0, 1)
        this.#isPlaying.setValue(false)
        this.#commands.stop(true)
    }
    wake(): void {Atomics.store(this.#controlFlags, 0, 0)}
    loadClickSound(index: 0 | 1, data: AudioData): void {this.#commands.loadClickSound(index, data)}

    get isPlaying(): ObservableValue<boolean> {return this.#isPlaying}
    get isRecording(): ObservableValue<boolean> {return this.#isRecording}
    get isCountingIn(): ObservableValue<boolean> {return this.#isCountingIn}
    get countInBeatsRemaining(): ObservableValue<number> {return this.#countInBeatsRemaining}
    get position(): ObservableValue<ppqn> {return this.#position}
    get bpm(): ObservableValue<bpm> {return this.#bpm}
    get playbackTimestamp(): MutableObservableValue<number> {return this.#playbackTimestamp}
    get markerState(): ObservableValue<Nullable<[UUID.Bytes, int]>> {return this.#markerState}
    get project(): Project {return this.#project}
    get preferences(): PreferencesHost<EngineSettings> {return this.#preferences}
    get cpuLoad(): ObservableValue<number> {return this.#cpuLoad}
    get perfBuffer(): Float32Array {return this.#perfBuffer}
    get perfIndex(): number {return this.#perfIndex}

    isReady(): Promise<void> {return this.#isReady}
    queryLoadingComplete(): Promise<boolean> {return this.#commands.queryLoadingComplete()}
    noteSignal(signal: NoteSignal): void {this.#commands.noteSignal(signal)}
    subscribeNotes(observer: Observer<NoteSignal>): Subscription {return this.#notifyNoteSignals.subscribe(observer)}
    ignoreNoteRegion(uuid: UUID.Bytes): void {this.#commands.ignoreNoteRegion(uuid)}
    scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void {
        this.#notifyClipNotification.notify({type: "waiting", clips: clipIds})
        this.#commands.scheduleClipPlay(clipIds)
    }
    scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void {
        this.#commands.scheduleClipStop(trackIds)
    }
    subscribeClipNotification(observer: Observer<ClipNotification>): Subscription {
        observer({
            type: "sequencing",
            changes: {started: this.#playingClips, stopped: Arrays.empty(), obsolete: Arrays.empty()}
        })
        return this.#notifyClipNotification.subscribe(observer)
    }

    terminate(): void {
        this.#commands.terminate()
        this.#terminator.terminate()
        this.disconnect()
    }
}