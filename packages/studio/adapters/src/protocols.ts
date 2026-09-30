import {int, Nullable, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {ClipSequencingUpdates} from "./ClipNotifications"
import {NoteSignal} from "./NoteSignal"
import type {SoundFont2} from "soundfont2"

export type MonitoringMapEntry = { uuid: UUID.Bytes, channels: ReadonlyArray<int> }

export type WclapBundleFile = { path: string, bytes: Uint8Array<ArrayBuffer> }
export type WclapBundle = { files: ReadonlyArray<WclapBundleFile> }
// uri "" = plugin not ready, width/height 0 = the plugin names no size
export type WclapGuiInfo = { uri: string, width: number, height: number }
// one plugin of a bundle's factory, `features` as CLAP lists them ("instrument", "audio-effect", ...)
export type WclapPluginInfo = { clapId: string, name: string, vendor: string, features: ReadonlyArray<string> }

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
    // WCLAP webview relay
    wclapOpenGui(uuid: UUID.Bytes): Promise<WclapGuiInfo>
    wclapCloseGui(uuid: UUID.Bytes): void
    wclapReceive(uuid: UUID.Bytes, bytes: ArrayBuffer): void
    // save the plugin's state now (answered through EngineToClient.wclapState when it changed)
    wclapSaveState(uuid: UUID.Bytes): void
    // the plugins a bundle offers (fetches and instantiates the module once, cached per url)
    wclapDescribe(url: string): Promise<ReadonlyArray<WclapPluginInfo>>
}

export interface EngineToClient {
    log(message: string): void
    error(reason: unknown): void
    deviceMessage(uuid: string, message: string): void
    fetchAudio(uuid: UUID.Bytes): Promise<AudioData>
    fetchSoundfont(uuid: UUID.Bytes): Promise<SoundFont2>
    fetchNamWasm(): Promise<ArrayBuffer>
    fetchWclapBundle(url: string): Promise<WclapBundle>
    wclapSend(uuid: string, bytes: ArrayBuffer): void
    wclapState(uuid: string, bytes: ArrayBuffer): void
    notifyClipSequenceChanges(changes: ClipSequencingUpdates): void
    switchMarkerState(state: Nullable<[UUID.Bytes, int]>): void
    recordingStarted(contextTime: number, position: ppqn, generation: int): void
    ready(): void
}