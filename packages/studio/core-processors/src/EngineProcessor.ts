import {
    Arrays,
    assert,
    EmptyExec,
    int,
    isDefined,
    Notifier,
    Nullable,
    Observer,
    Option,
    panic,
    quantizeFloor,
    SortedSet,
    Subscription,
    SyncStream,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {BoxGraph, createSyncTarget} from "@opendaw/lib-box"
import {AudioFileBox, BoxIO, BoxVisitor} from "@opendaw/studio-boxes"
import {EngineContext} from "./EngineContext"
import {TimeInfo} from "./TimeInfo"
import {
    AnyClipBoxAdapter,
    AudioUnitBoxAdapter,
    BoxAdapters,
    ClipAdapters,
    ClipSequencing,
    ClipSequencingUpdates,
    EngineAddresses,
    EngineCommands,
    EngineProcessorAttachment,
    EngineStateSchema,
    EngineToClient,
    NoteSignal,
    ParameterFieldAdapters,
    ProjectSkeleton,
    RootBoxAdapter,
    SampleLoaderManager,
    SoundfontLoaderManager,
    TimelineBoxAdapter,
    TrackBoxAdapter
} from "@opendaw/studio-adapters"
import {AudioUnit} from "./AudioUnit"
import {Processor, ProcessPhase} from "./processing"
import {Mixer} from "./Mixer"
import {LiveStreamBroadcaster} from "@opendaw/lib-fusion"
import {UpdateClock} from "./UpdateClock"
import {PeakBroadcaster} from "./PeakBroadcaster"
import {Metronome} from "./Metronome"
import {AudioOutputBufferRegistry} from "./AudioOutputBufferRegistry"
import {BlockRenderer} from "./BlockRenderer"
import {
    AudioAnalyser,
    AudioData,
    ConstantTempoMap,
    Graph,
    PPQN,
    ppqn,
    RenderQuantum,
    TempoMap,
    TopologicalSort
} from "@opendaw/lib-dsp"
import {SampleManagerWorklet} from "./SampleManagerWorklet"
import {ClipSequencingAudioContext} from "./ClipSequencingAudioContext"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {AudioUnitOptions} from "./AudioUnitOptions"
import type {SoundFont2} from "soundfont2"
import {SoundfontManagerWorklet} from "./SoundfontManagerWorklet"
import {MidiData} from "@opendaw/lib-midi"
import {MIDITransportClock} from "./MIDITransportClock"
import {MIDISender} from "./MIDISender"

const DEBUG = false

export class EngineProcessor extends AudioWorkletProcessor implements EngineContext {
    readonly #terminator: Terminator
    readonly #messenger: Messenger
    readonly #boxGraph: BoxGraph<BoxIO.TypeMap>
    readonly #timeInfo: TimeInfo
    readonly #engineToClient: EngineToClient
    readonly #boxAdapters: BoxAdapters
    readonly #sampleManager: SampleLoaderManager
    readonly #soundfontManager: SoundfontLoaderManager
    readonly #audioUnits: SortedSet<UUID.Bytes, AudioUnit>
    readonly #rootBoxAdapter: RootBoxAdapter
    readonly #timelineBoxAdapter: TimelineBoxAdapter
    readonly #tempoMap: TempoMap
    readonly #parameterFieldAdapters: ParameterFieldAdapters
    readonly #audioGraph: Graph<Processor>
    readonly #audioGraphSorting: TopologicalSort<Processor>
    readonly #notifier: Notifier<ProcessPhase>
    readonly #mixer: Mixer
    readonly #liveStreamBroadcaster: LiveStreamBroadcaster
    readonly #clipSequencing: ClipSequencingAudioContext
    readonly #updateClock: UpdateClock
    readonly #peaks: PeakBroadcaster
    readonly #analyser: AudioAnalyser
    readonly #metronome: Metronome
    readonly #midiTransportClock: MIDITransportClock
    readonly #audioOutputBufferRegistry: AudioOutputBufferRegistry

    readonly #renderer: BlockRenderer
    readonly #stateSender: SyncStream.Writer
    readonly #controlFlags: Int32Array<SharedArrayBuffer>
    readonly #stemExports: ReadonlyArray<AudioUnit>
    readonly #ignoredRegions: SortedSet<UUID.Bytes, UUID.Bytes>

    #processQueue: Option<ReadonlyArray<Processor>> = Option.None
    #primaryOutput: Option<AudioUnit> = Option.None

    #context: Option<EngineContext> = Option.None
    #midiSender: Option<MIDISender> = Option.None
    #panic: boolean = false // will throw an error if set to true to test error handling
    #valid: boolean = true // to shut down the engine
    #metronomeEnabled: boolean = false
    #recordingStartTime: ppqn = 0.0
    #playbackTimestamp: ppqn = 0.0 // this is where we start playing again (after paused)
    #playbackTimestampEnabled: boolean = true
    #countInBarsTotal: int = 1

    constructor({processorOptions: {syncStreamBuffer, controlFlagsBuffer, project, exportConfiguration, options}}: {
        processorOptions: EngineProcessorAttachment
    } & AudioNodeOptions) {
        super()

        const {boxGraph, mandatoryBoxes: {rootBox, timelineBox}} = ProjectSkeleton.decode(project)

        this.#terminator = new Terminator()
        this.#messenger = Messenger.for(this.port)
        this.#boxGraph = boxGraph
        this.#timeInfo = new TimeInfo()
        this.#controlFlags = new Int32Array<SharedArrayBuffer>(controlFlagsBuffer)
        this.#engineToClient = Communicator.sender<EngineToClient>(
            this.#messenger.channel("engine-to-client"),
            dispatcher => new class implements EngineToClient {
                log(message: string): void {dispatcher.dispatchAndForget(this.log, message)}
                error(error: unknown): void {dispatcher.dispatchAndForget(this.error, error)}
                fetchAudio(uuid: UUID.Bytes): Promise<AudioData> {
                    return dispatcher.dispatchAndReturn(this.fetchAudio, uuid)
                }
                fetchSoundfont(uuid: UUID.Bytes): Promise<SoundFont2> {
                    return dispatcher.dispatchAndReturn(this.fetchSoundfont, uuid)
                }
                notifyClipSequenceChanges(changes: ClipSequencingUpdates): void {
                    dispatcher.dispatchAndForget(this.notifyClipSequenceChanges, changes)
                }
                switchMarkerState(state: Nullable<[UUID.Bytes, int]>): void {
                    dispatcher.dispatchAndForget(this.switchMarkerState, state)
                }
                ready() {dispatcher.dispatchAndForget(this.ready)}
            })
        this.#sampleManager = new SampleManagerWorklet(this.#engineToClient)
        this.#soundfontManager = new SoundfontManagerWorklet(this.#engineToClient)
        this.#audioUnits = UUID.newSet(unit => unit.adapter.uuid)
        this.#parameterFieldAdapters = new ParameterFieldAdapters()
        this.#tempoMap = new ConstantTempoMap(timelineBox.bpm)
        this.#boxAdapters = this.#terminator.own(new BoxAdapters(this))
        this.#rootBoxAdapter = this.#boxAdapters.adapterFor(rootBox, RootBoxAdapter)
        this.#timelineBoxAdapter = this.#boxAdapters.adapterFor(timelineBox, TimelineBoxAdapter)
        this.#audioGraph = new Graph<Processor>()
        this.#audioGraphSorting = new TopologicalSort<Processor>(this.#audioGraph)
        this.#notifier = new Notifier<ProcessPhase>()
        this.#mixer = new Mixer()
        this.#metronome = new Metronome(this.#timelineBoxAdapter, this.#timeInfo)
        this.#midiTransportClock = new MIDITransportClock(this, this.#rootBoxAdapter)
        this.#audioOutputBufferRegistry = new AudioOutputBufferRegistry()
        this.#renderer = new BlockRenderer(this, options)
        this.#ignoredRegions = UUID.newSet<UUID.Bytes>(uuid => uuid)
        this.#stateSender = SyncStream.writer(EngineStateSchema(), syncStreamBuffer, x => {
            const {transporting, isCountingIn, isRecording, position} = this.#timeInfo
            const denominator = this.#timelineBoxAdapter.box.signature.denominator.getValue()
            x.position = position
            x.playbackTimestamp = this.#playbackTimestamp
            x.countInBeatsRemaining = isCountingIn ? (this.#recordingStartTime - position) / PPQN.fromSignature(1, denominator) : 0
            x.isPlaying = transporting
            x.isRecording = isRecording
            x.isCountingIn = isCountingIn
        })
        this.#liveStreamBroadcaster = this.#terminator.own(LiveStreamBroadcaster.create(this.#messenger, "engine-live-data"))
        this.#updateClock = new UpdateClock(this)
        this.#peaks = this.#terminator.own(new PeakBroadcaster(this.#liveStreamBroadcaster, EngineAddresses.PEAKS))
        this.#analyser = new AudioAnalyser()
        const spectrum = new Float32Array(this.#analyser.numBins())
        const waveform = new Float32Array(this.#analyser.numBins())
        this.#terminator.own(this.#liveStreamBroadcaster.broadcastFloats(EngineAddresses.SPECTRUM, spectrum,
            (hasSubscribers) => {
                if (!hasSubscribers) {return}
                spectrum.set(this.#analyser.bins())
                this.#analyser.decay = true
            }))
        this.#terminator.own(this.#liveStreamBroadcaster.broadcastFloats(EngineAddresses.WAVEFORM, waveform,
            (hasSubscribers) => {
                if (!hasSubscribers) {return}
                waveform.set(this.#analyser.waveform())
            }))
        this.#clipSequencing = this.#terminator.own(new ClipSequencingAudioContext(this.#boxGraph))
        this.#terminator.ownAll(
            createSyncTarget(this.#boxGraph, this.#messenger.channel("engine-sync")),
            Communicator.executor<EngineCommands>(this.#messenger.channel("engine-commands"), {
                play: (): void => this.#play(),
                stop: (reset: boolean): void => this.#stop(reset),
                setPosition: (position: number): void => this.#setPosition(position),
                prepareRecordingState: (countIn: boolean): void => this.#prepareRecordingState(countIn),
                stopRecording: (): void => this.#stopRecording(),
                setMetronomeEnabled: (value: boolean) => this.#timeInfo.metronomeEnabled = this.#metronomeEnabled = value,
                setPlaybackTimestampEnabled: (value: boolean) => this.#playbackTimestampEnabled = value,
                setCountInBarsTotal: (value: int) => this.#countInBarsTotal = value,
                queryLoadingComplete: (): Promise<boolean> =>
                    Promise.resolve(this.#boxGraph.boxes().every(box => box.accept<BoxVisitor<boolean>>({
                        visitAudioFileBox: (box: AudioFileBox) =>
                            this.#sampleManager.getOrCreate(box.address.uuid).data.nonEmpty() && box.pointerHub.nonEmpty()
                    }) ?? true)),
                panic: () => this.#panic = true,
                noteSignal: (signal: NoteSignal) => {
                    if (NoteSignal.isOn(signal)) {
                        const {uuid, pitch, velocity} = signal
                        this.optAudioUnit(uuid)
                            .ifSome(unit => unit.midiDeviceChain.noteSequencer.pushRawNoteOn(pitch, velocity))
                    } else if (NoteSignal.isOff(signal)) {
                        const {uuid, pitch} = signal
                        this.optAudioUnit(uuid)
                            .ifSome(unit => unit.midiDeviceChain.noteSequencer.pushRawNoteOff(pitch))
                    } else if (NoteSignal.isAudition(signal)) {
                        const {uuid, pitch, duration, velocity} = signal
                        this.optAudioUnit(uuid)
                            .ifSome(unit => unit.midiDeviceChain.noteSequencer.auditionNote(pitch, duration, velocity))
                    }
                },
                ignoreNoteRegion: (uuid: UUID.Bytes) => this.#ignoredRegions.add(uuid),
                scheduleClipPlay: (clipIds: ReadonlyArray<UUID.Bytes>) => {
                    clipIds.forEach(clipId => {
                        const optClipBox = this.#boxGraph.findBox(clipId)
                        if (optClipBox.isEmpty()) {
                            console.warn(`Could not scheduleClipPlay. Cannot find clip: '${UUID.toString(clipId)}'`)
                        } else {
                            const clipAdapter: AnyClipBoxAdapter = ClipAdapters.for(this.#boxAdapters, optClipBox.unwrap())
                            this.#clipSequencing.schedulePlay(clipAdapter)
                        }
                    })
                    this.#timeInfo.transporting = true
                    this.#midiTransportClock.schedule(MidiData.Start)
                },
                scheduleClipStop: (trackIds: ReadonlyArray<UUID.Bytes>) => {
                    trackIds.forEach(trackId => {
                        const optClipBox = this.#boxGraph.findBox(trackId)
                        if (optClipBox.isEmpty()) {
                            console.warn(`Could not scheduleClipStop. Cannot find track: '${UUID.toString(trackId)}'`)
                        } else {
                            this.#clipSequencing.scheduleStop(this.#boxAdapters.adapterFor(optClipBox.unwrap(), TrackBoxAdapter))
                        }
                    })
                },
                setupMIDI: (port: MessagePort, buffer: SharedArrayBuffer) => {
                    this.#midiSender = Option.wrap(new MIDISender(port, buffer))
                },
                terminate: () => {
                    this.#context.ifSome(context => context.terminate())
                    this.#context = Option.None
                    this.#valid = false
                    this.#ignoredRegions.clear()
                    this.#terminator.terminate()
                }
            }),
            this.#rootBoxAdapter.audioUnits.catchupAndSubscribe({
                onAdd: (adapter: AudioUnitBoxAdapter) => {
                    const uuidAsString = UUID.toString(adapter.uuid)
                    const options: AudioUnitOptions = isDefined(exportConfiguration?.[uuidAsString])
                        ? exportConfiguration[uuidAsString]
                        : AudioUnitOptions.Default
                    const audioUnit = new AudioUnit(this, adapter, options)
                    const added = this.#audioUnits.add(audioUnit)
                    assert(added, `Could not add ${audioUnit}`)
                    if (audioUnit.adapter.isOutput) {
                        assert(this.#primaryOutput.isEmpty(), "Output can only assigned once.")
                        this.#primaryOutput = Option.wrap(audioUnit)
                        return
                    }
                },
                onRemove: ({uuid}) => this.#audioUnits.removeByKey(uuid).terminate(),
                onReorder: EmptyExec
            })
        )

        this.#stemExports = Option.wrap(exportConfiguration).match({
            none: () => Arrays.empty(),
            some: configuration => Object.keys(configuration).map(uuidString => this.#audioUnits.get(UUID.parse(uuidString)))
        })

        this.#engineToClient.ready()

        // For Safari :(
        console.log = (...message: string[]) => this.#engineToClient.log(message.join(", "))
    }

    ignoresRegion(uuid: UUID.Bytes): boolean {return this.#ignoredRegions.hasKey(uuid)}

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (!this.#valid) {return false} // will not revive
        if (Atomics.load(this.#controlFlags, 0) === 1) {return true} // sleeps. can be awake
        try {
            return this.render(inputs, outputs)
        } catch (reason: any) {
            console.debug(reason)
            this.#valid = false
            this.#engineToClient.error(reason)
            this.terminate()
            return false
        }
    }

    render(_inputs: Float32Array[][], [output]: Float32Array[][]): boolean {
        if (!this.#valid) {return false}
        if (this.#panic) {return panic("Manual Panic")}
        const metronomeEnabled = this.#timeInfo.metronomeEnabled
        this.#notifier.notify(ProcessPhase.Before)
        if (this.#processQueue.isEmpty()) {
            this.#audioGraphSorting.update()
            this.#processQueue = Option.wrap(this.#audioGraphSorting.sorted().concat())
            if (DEBUG) {
                console.debug(`%cAudio-Graph%c\n${this.#processQueue.unwrap()
                        .map((x, index) => `${(index + 1)}: ${x}`).join("\n")}`,
                    "color: hsl(200, 83%, 60%)", "color: inherit")
            }
        }
        const processors = this.#processQueue.unwrap()
        this.#renderer.process(processInfo => {
            processors.forEach(processor => processor.process(processInfo))
            if (metronomeEnabled) {this.#metronome.process(processInfo)}
        })
        if (this.#stemExports.length === 0) {
            this.#primaryOutput.unwrap().audioOutput().replaceInto(output)
            if (metronomeEnabled) {this.#metronome.output.mixInto(output)}
            this.#peaks.process(output[0], output[1])
            this.#analyser.process(output[0], output[1], 0, RenderQuantum)
        } else {
            this.#stemExports.forEach((unit: AudioUnit, index: int) => {
                const [l, r] = unit.audioOutput().channels()
                output[index * 2].set(l)
                output[index * 2 + 1].set(r)
            })
        }
        this.#notifier.notify(ProcessPhase.After)
        this.#clipSequencing.changes().ifSome(changes => this.#engineToClient.notifyClipSequenceChanges(changes))
        this.#stateSender.tryWrite()
        this.#liveStreamBroadcaster.flush()
        return true
    }

    getAudioUnit(uuid: UUID.Bytes): AudioUnit {return this.#audioUnits.get(uuid)}
    optAudioUnit(uuid: UUID.Bytes): Option<AudioUnit> {return this.#audioUnits.opt(uuid)}

    subscribeProcessPhase(observer: Observer<ProcessPhase>): Subscription {return this.#notifier.subscribe(observer)}

    registerProcessor(processor: Processor): Terminable {
        this.#audioGraph.addVertex(processor)
        this.#processQueue = Option.None
        return {
            terminate: () => {
                this.#audioGraph.removeVertex(processor)
                this.#processQueue = Option.None
            }
        }
    }

    registerEdge(source: Processor, target: Processor): Terminable {
        this.#audioGraph.addEdge([source, target])
        this.#processQueue = Option.None
        return {
            terminate: () => {
                this.#audioGraph.removeEdge([source, target])
                this.#processQueue = Option.None
            }
        }
    }

    get boxGraph(): BoxGraph<BoxIO.TypeMap> {return this.#boxGraph}
    get boxAdapters(): BoxAdapters {return this.#boxAdapters}
    get sampleManager(): SampleLoaderManager {return this.#sampleManager}
    get soundfontManager(): SoundfontLoaderManager {return this.#soundfontManager}
    get rootBoxAdapter(): RootBoxAdapter {return this.#rootBoxAdapter}
    get timelineBoxAdapter(): TimelineBoxAdapter {return this.#timelineBoxAdapter}
    get signatureDuration(): ppqn {return this.timelineBoxAdapter.signatureDuration}
    get tempoMap(): TempoMap {return this.#tempoMap}
    get liveStreamBroadcaster(): LiveStreamBroadcaster {return this.#liveStreamBroadcaster}
    get liveStreamReceiver(): never {return panic("Only available in main thread")}
    get parameterFieldAdapters(): ParameterFieldAdapters {return this.#parameterFieldAdapters}
    get clipSequencing(): ClipSequencing {return this.#clipSequencing}
    get broadcaster(): LiveStreamBroadcaster {return this.#liveStreamBroadcaster}
    get updateClock(): UpdateClock {return this.#updateClock}
    get timeInfo(): TimeInfo {return this.#timeInfo}
    get mixer(): Mixer {return this.#mixer}
    get engineToClient(): EngineToClient {return this.#engineToClient}
    get isMainThread(): boolean {return false}
    get isAudioContext(): boolean {return true}
    get audioOutputBufferRegistry(): AudioOutputBufferRegistry {return this.#audioOutputBufferRegistry}

    sendMIDIData(midiDeviceId: string, data: Uint8Array, relativeTimeInMs: number): void {
        this.#midiSender.ifSome(sender => sender.send(midiDeviceId, data, relativeTimeInMs))
    }

    terminate(): void {
        console.trace(`terminate: ${this}`)
        this.#terminator.terminate()
        this.#audioUnits.forEach(unit => unit.terminate())
        this.#audioUnits.clear()
    }

    #play(): void {
        if (this.#playbackTimestampEnabled) {
            this.#timeInfo.position = this.#playbackTimestamp
            this.#midiTransportClock.schedule(MidiData.positionInPPQN(this.#timeInfo.position))
        }
        this.#timeInfo.transporting = true
        this.#midiTransportClock.schedule(MidiData.Start)
    }

    #stop(reset: boolean): void {
        if (this.#timeInfo.isRecording || this.#timeInfo.isCountingIn) {
            this.#timeInfo.isRecording = false
            this.#timeInfo.isCountingIn = false
            this.#timeInfo.position = this.#playbackTimestampEnabled ? this.#playbackTimestamp : 0.0
            this.#midiTransportClock.schedule(MidiData.positionInPPQN(this.#timeInfo.position))
        }
        const wasTransporting = this.#timeInfo.transporting
        this.#timeInfo.transporting = false
        this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
        this.#ignoredRegions.clear()
        if (reset || !wasTransporting) {
            this.#reset()
        }
        this.#midiTransportClock.schedule(MidiData.Stop)
    }

    #setPosition(position: number): void {
        if (!this.#timeInfo.isRecording) {
            this.#timeInfo.position = this.#playbackTimestamp = position
            this.#midiTransportClock.schedule(MidiData.positionInPPQN(this.#timeInfo.position))
        }
    }

    #prepareRecordingState(countIn: boolean): void {
        if (this.#timeInfo.isRecording || this.#timeInfo.isCountingIn) {return}
        if (!this.#timeInfo.transporting && countIn) {
            const position = this.#timeInfo.position
            const [nominator, denominator] = this.#timelineBoxAdapter.signature
            this.#recordingStartTime = quantizeFloor(position, PPQN.fromSignature(nominator, denominator))
            this.#timeInfo.isCountingIn = true
            this.#timeInfo.metronomeEnabled = true
            this.#timeInfo.transporting = true
            this.#timeInfo.position = this.#recordingStartTime - PPQN.fromSignature(this.#countInBarsTotal * nominator, denominator)
            const subscription = this.#renderer.setCallback(this.#recordingStartTime, () => {
                this.#timeInfo.isCountingIn = false
                this.#timeInfo.isRecording = true
                this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
                subscription.terminate()
            })
            this.#midiTransportClock.schedule(MidiData.positionInPPQN(this.#timeInfo.position))
        } else {
            this.#timeInfo.transporting = true
            this.#timeInfo.isRecording = true
            this.#midiTransportClock.schedule(MidiData.Start)
        }
    }

    #stopRecording(): void {
        if (!this.#timeInfo.isRecording && !this.#timeInfo.isCountingIn) {return}
        this.#timeInfo.isRecording = false
        this.#timeInfo.isCountingIn = false
        this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
        this.#timeInfo.transporting = false
        this.#ignoredRegions.clear()
        this.#midiTransportClock.schedule(MidiData.Stop)
    }

    #reset(): void {
        this.#playbackTimestamp = 0.0
        this.#timeInfo.isRecording = false
        this.#timeInfo.isCountingIn = false
        this.#timeInfo.metronomeEnabled = this.#metronomeEnabled
        this.#timeInfo.position = 0.0
        this.#timeInfo.transporting = false
        this.#renderer.reset()
        this.#clipSequencing.reset()
        this.#audioGraphSorting.sorted().forEach(processor => processor.reset())
        this.#peaks.clear()
    }
}