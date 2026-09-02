import {
    int,
    Nullable,
    ObservableOption,
    ObservableValue,
    Observer,
    Procedure,
    Subscription,
    Terminable,
    UUID
} from "@opendaw/lib-std"
import {AudioData, bpm, ppqn} from "@opendaw/lib-dsp"
import {ClipNotification, EnginePreferences, NoteSignal} from "@opendaw/studio-adapters"
import {Project} from "./project"

// Where and when the transport began recording, as reported by the engine from the audio thread:
// `position` is the playhead after the render quantum in which recording began and `contextTime` is
// the context clock at the end of that quantum. Empty until the engine reports it; cleared when a
// recording is prepared.
export type RecordingStart = {readonly contextTime: number, readonly position: ppqn}

export interface Engine extends Terminable {
    play(): void
    stop(): void
    setPosition(position: ppqn): void
    /** @internal */
    prepareRecordingState(countIn: boolean): void
    /** @internal */
    stopRecording(): void
    isReady(): Promise<void>
    queryLoadingComplete(): Promise<boolean>
    stop(): void
    panic(): void
    sleep(): void
    wake(): void
    loadClickSound(index: 0 | 1, data: AudioData): void
    setFrozenAudio(uuid: UUID.Bytes, audioData: Nullable<AudioData>): void
    noteSignal(signal: NoteSignal): void
    subscribeNotes(observer: Observer<NoteSignal>): Subscription
    ignoreNoteRegion(uuid: UUID.Bytes): void
    suspendAutomation(uuid: UUID.Bytes): void
    scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void
    scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void
    subscribeClipNotification(observer: Observer<ClipNotification>): Subscription
    subscribeDeviceMessage(uuid: string, listener: Procedure<string>): Subscription
    registerMonitoringSource(uuid: UUID.Bytes, node: AudioNode, numChannels: 1 | 2, destinationNode: AudioNode): void
    unregisterMonitoringSource(uuid: UUID.Bytes): void

    get position(): ObservableValue<ppqn>
    get recordingStart(): ObservableOption<RecordingStart>
    get bpm(): ObservableValue<bpm>
    get isPlaying(): ObservableValue<boolean>
    get isRecording(): ObservableValue<boolean>
    get isCountingIn(): ObservableValue<boolean>
    get playbackTimestamp(): ObservableValue<ppqn>
    get countInBeatsRemaining(): ObservableValue<number>
    get markerState(): ObservableValue<Nullable<[UUID.Bytes, int]>>
    get cpuLoad(): ObservableValue<number>
    get project(): Project
    get preferences(): EnginePreferences
    get perfBuffer(): Float32Array
    get perfIndex(): number
}