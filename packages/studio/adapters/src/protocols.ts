import {int, Nullable, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {ClipSequencingUpdates} from "./ClipNotifications"
import {NoteSignal} from "./NoteSignal"
import type {SoundFont2} from "soundfont2"

export interface EngineCommands extends Terminable {
    play(): void
    stop(reset: boolean): void
    setPosition(position: ppqn): void
    prepareRecordingState(countIn: boolean): void
    stopRecording(): void
    queryLoadingComplete(): Promise<boolean>
    // throws a test error while processing audio
    panic(): void
    // feeds a note request into an audio-unit identified by uuid
    noteSignal(signal: NoteSignal): void
    ignoreNoteRegion(uuid: UUID.Bytes): void
    // timeline clip playback management
    scheduleClipPlay(clipIds: ReadonlyArray<UUID.Bytes>): void
    scheduleClipStop(trackIds: ReadonlyArray<UUID.Bytes>): void
    setupMIDI(port: MessagePort, buffer: SharedArrayBuffer): void
    // metronome
    loadClickSound(index: 0 | 1, data: AudioData): void
}

export interface EngineToClient {
    log(message: string): void
    error(reason: unknown): void
    fetchAudio(uuid: UUID.Bytes): Promise<AudioData>
    fetchSoundfont(uuid: UUID.Bytes): Promise<SoundFont2>
    notifyClipSequenceChanges(changes: ClipSequencingUpdates): void
    switchMarkerState(state: Nullable<[UUID.Bytes, int]>): void
    ready(): void
}