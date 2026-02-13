import {
    DefaultObservableValue,
    int,
    Nullable,
    ObservableValue,
    Observer,
    Option,
    Subscription,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {AudioData, bpm, ppqn} from "@opendaw/lib-dsp"
import {
    ClipNotification,
    EnginePreferences,
    EngineSettings,
    EngineSettingsSchema,
    NoteSignal,
    PreferencesFacade
} from "@opendaw/studio-adapters"
import {Engine} from "./Engine"
import {EngineWorklet} from "./EngineWorklet"
import {Project} from "./project"
import {Preferences} from "@opendaw/lib-fusion"

export class EngineFacade implements Engine {
    readonly #terminator: Terminator = new Terminator()
    readonly #lifecycle: Terminator = this.#terminator.own(new Terminator())
    readonly #playbackTimestamp: DefaultObservableValue<ppqn> = new DefaultObservableValue(0.0)
    readonly #countInBeatsRemaining: DefaultObservableValue<int> = new DefaultObservableValue(0)
    readonly #position: DefaultObservableValue<ppqn> = new DefaultObservableValue(0.0)
    readonly #bpm: DefaultObservableValue<bpm> = new DefaultObservableValue(12.0)
    readonly #isPlaying: DefaultObservableValue<boolean> = new DefaultObservableValue(false)
    readonly #isRecording: DefaultObservableValue<boolean> = new DefaultObservableValue(false)
    readonly #isCountingIn: DefaultObservableValue<boolean> = new DefaultObservableValue(false)
    readonly #markerState: DefaultObservableValue<Nullable<[UUID.Bytes, int]>> =
        new DefaultObservableValue<Nullable<[UUID.Bytes, int]>>(null)
    readonly #cpuLoad: DefaultObservableValue<number> = new DefaultObservableValue(0)
    readonly #preferencesFacade: PreferencesFacade<EngineSettings>

    #worklet: Option<EngineWorklet> = Option.None

    constructor() {
        this.#preferencesFacade = Preferences.facade("engine-preferences", EngineSettingsSchema)
    }

    setWorklet(worklet: EngineWorklet) {
        this.#worklet = Option.wrap(worklet)
        this.#preferencesFacade.setHost(worklet.preferences)
        this.#lifecycle.terminate()
        this.#lifecycle.ownAll(
            worklet.playbackTimestamp.catchupAndSubscribe(owner => this.#playbackTimestamp.setValue(owner.getValue())),
            worklet.countInBeatsRemaining.catchupAndSubscribe(owner => this.#countInBeatsRemaining.setValue(owner.getValue())),
            worklet.position.catchupAndSubscribe(owner => this.#position.setValue(owner.getValue())),
            worklet.bpm.catchupAndSubscribe(owner => this.#bpm.setValue(owner.getValue())),
            worklet.isPlaying.catchupAndSubscribe(owner => this.#isPlaying.setValue(owner.getValue())),
            worklet.isRecording.catchupAndSubscribe(owner => this.#isRecording.setValue(owner.getValue())),
            worklet.isCountingIn.catchupAndSubscribe(owner => this.#isCountingIn.setValue(owner.getValue())),
            worklet.markerState.catchupAndSubscribe(owner => this.#markerState.setValue(owner.getValue())),
            worklet.cpuLoad.catchupAndSubscribe(owner => this.#cpuLoad.setValue(owner.getValue()))
        )
    }

    assertWorklet(): void {this.#worklet.unwrap("No worklet available")}

    releaseWorklet(): void {
        this.#worklet.ifSome(worklet => worklet.terminate())
        this.#preferencesFacade.releaseHost()
        this.#lifecycle.terminate()
        this.#worklet = Option.None
    }

    play(): void {
        this.#worklet.ifSome(worklet => {
            const context = worklet.context as AudioContext
            if (context.state === "suspended") {
                context.resume().then(() => worklet.play())
            } else {
                worklet.play()
            }
        })
    }
    stop(reset: boolean = false): void {this.#worklet.ifSome(worklet => worklet.stop(reset))}
    setPosition(position: ppqn): void {this.#worklet.ifSome(worklet => worklet.setPosition(position))}
    prepareRecordingState(countIn: boolean): void {this.#worklet.ifSome(worklet => worklet.prepareRecordingState(countIn))}
    stopRecording(): void {this.#worklet.ifSome(worklet => worklet.stopRecording())}

    get position(): ObservableValue<ppqn> {return this.#position}
    get bpm(): ObservableValue<bpm> {return this.#bpm}
    get isPlaying(): ObservableValue<boolean> {return this.#isPlaying}
    get isRecording(): ObservableValue<boolean> {return this.#isRecording}
    get isCountingIn(): ObservableValue<boolean> {return this.#isCountingIn}
    get playbackTimestamp(): ObservableValue<ppqn> {return this.#playbackTimestamp}
    get countInBeatsRemaining(): ObservableValue<int> {return this.#countInBeatsRemaining}
    get markerState(): DefaultObservableValue<Nullable<[UUID.Bytes, int]>> {return this.#markerState}
    get cpuLoad(): ObservableValue<number> {return this.#cpuLoad}
    get project(): Project {return this.#worklet.unwrap("No worklet to get project").project}
    get sampleRate(): number {return this.#worklet.isEmpty() ? 44_100 : this.#worklet.unwrap().context.sampleRate}
    get preferences(): EnginePreferences {return this.#preferencesFacade}
    get perfBuffer(): Float32Array {return this.#worklet.mapOr(worklet => worklet.perfBuffer, new Float32Array(0))}
    get perfIndex(): number {return this.#worklet.mapOr(worklet => worklet.perfIndex, 0)}

    isReady(): Promise<void> {return this.#worklet.mapOr(worklet => worklet.isReady(), Promise.resolve())}
    queryLoadingComplete(): Promise<boolean> {
        return this.#worklet.mapOr(worklet => worklet.queryLoadingComplete(), Promise.resolve(false))
    }
    panic(): void {this.#worklet.ifSome(worklet => worklet.panic())}
    sleep(): void {this.#worklet.ifSome(worklet => worklet.sleep())}
    wake(): void {this.#worklet.ifSome(worklet => worklet.wake())}
    loadClickSound(index: 0 | 1, data: AudioData): void {
        this.#worklet.ifSome(worklet => worklet.loadClickSound(index, data))
    }
    subscribeClipNotification(observer: Observer<ClipNotification>): Subscription {
        return this.#worklet.unwrap("No worklet to subscribeClipNotification").subscribeClipNotification(observer)
    }
    subscribeNotes(observer: Observer<NoteSignal>): Subscription {
        return this.#worklet.unwrap("No worklet to subscribeNotes").subscribeNotes(observer)
    }
    ignoreNoteRegion(uuid: UUID.Bytes): void {
        this.#worklet.unwrap("No worklet to ignoreNoteRegion").ignoreNoteRegion(uuid)
    }
    noteSignal(signal: NoteSignal): void {
        this.#worklet.unwrap("No worklet to noteOn").noteSignal(signal)
    }
    scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void {
        this.#worklet.unwrap("No worklet to scheduleClipPlay").scheduleClipPlay(clipIds)
    }
    scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void {
        this.#worklet.unwrap("No worklet to scheduleClipStop").scheduleClipStop(trackIds)
    }
    registerMonitoringSource(uuid: UUID.Bytes, node: AudioNode, numChannels: 1 | 2): void {
        this.#worklet.ifSome(worklet => worklet.registerMonitoringSource(uuid, node, numChannels))
    }
    unregisterMonitoringSource(uuid: UUID.Bytes): void {
        this.#worklet.ifSome(worklet => worklet.unregisterMonitoringSource(uuid))
    }

    terminate(): void {
        this.releaseWorklet()
        this.#terminator.terminate()
    }
}