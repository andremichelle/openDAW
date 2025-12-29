import {
    int,
    MutableObservableValue,
    Nullable,
    ObservableValue,
    Observer,
    Subscription,
    Terminable,
    UUID
} from "@opendaw/lib-std"
import {bpm, ppqn} from "@opendaw/lib-dsp"
import {ClipNotification, EnginePreferences, NoteSignal} from "@opendaw/studio-adapters"
import {Project} from "./project"

export interface Engine extends Terminable {
    play(): void
    stop(): void
    setPosition(position: ppqn): void
    prepareRecordingState(countIn: boolean): void
    stopRecording(): void
    isReady(): Promise<void>
    queryLoadingComplete(): Promise<boolean>
    stop(): void
    panic(): void
    sleep(): void
    wake(): void
    noteSignal(signal: NoteSignal): void
    subscribeNotes(observer: Observer<NoteSignal>): Subscription
    ignoreNoteRegion(uuid: UUID.Bytes): void
    scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void
    scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void
    subscribeClipNotification(observer: Observer<ClipNotification>): Subscription

    get position(): ObservableValue<ppqn>
    get bpm(): ObservableValue<bpm>
    get isPlaying(): ObservableValue<boolean>
    get isRecording(): ObservableValue<boolean>
    get isCountingIn(): ObservableValue<boolean>
    get playbackTimestamp(): ObservableValue<ppqn>
    get playbackTimestampEnabled(): MutableObservableValue<boolean>
    get countInBeatsRemaining(): ObservableValue<number>
    get markerState(): ObservableValue<Nullable<[UUID.Bytes, int]>>
    get project(): Project
    get preferences(): EnginePreferences
}