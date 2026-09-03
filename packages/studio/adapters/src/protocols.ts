import {int, Nullable, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {ClipSequencingUpdates} from "./ClipNotifications"
import {NoteSignal} from "./NoteSignal"
import type {SoundFont2} from "soundfont2"

export type MonitoringMapEntry = { uuid: UUID.Bytes, channels: ReadonlyArray<int> }

export interface EngineCommands extends Terminable {
    play(): void
    stop(reset: boolean): void
    setPosition(position: ppqn): void
    /** @internal */
    prepareRecordingState(countIn: boolean, generation: int): void
    /** @internal */
    stopRecording(): void
    queryLoadingComplete(): Promise<boolean>
    // throws a test error while processing audio
    panic(): void
    noteSignal(signal: NoteSignal): void
    /** @internal */
    ignoreNoteRegion(uuid: UUID.Bytes): void
    /** @internal */
    suspendAutomation(uuid: UUID.Bytes): void
    scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void
    scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void
    /** @internal */
    setupMIDI(port: MessagePort, buffer: SharedArrayBuffer): void
    loadClickSound(index: 0 | 1, data: AudioData): void
    setFrozenAudio(uuid: UUID.Bytes, audioData: Nullable<AudioData>): void
    /** @internal */
    updateMonitoringMap(map: ReadonlyArray<MonitoringMapEntry>): void
}

export interface EngineToClient {
    log(message: string): void
    error(reason: unknown): void
    deviceMessage(uuid: string, message: string): void
    fetchAudio(uuid: UUID.Bytes): Promise<AudioData>
    fetchSoundfont(uuid: UUID.Bytes): Promise<SoundFont2>
    fetchNamWasm(): Promise<ArrayBuffer>
    notifyClipSequenceChanges(changes: ClipSequencingUpdates): void
    switchMarkerState(state: Nullable<[UUID.Bytes, int]>): void
    // The transport began recording during the render quantum that ended at `contextTime` (audio-thread
    // clock) and left the playhead at `position`. Both describe the same instant, so a capture can pair
    // its own audio-thread anchors with the timeline without reading the main-thread state observables.
    // `generation` echoes the `prepareRecordingState` call the report belongs to.
    recordingStarted(contextTime: number, position: ppqn, generation: int): void
    ready(): void
}