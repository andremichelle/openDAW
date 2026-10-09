import {int, Nullable, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn} from "@opendaw/lib-dsp"
import {ClipSequencingUpdates} from "./ClipNotifications"
import {NoteSignal} from "./NoteSignal"
import type {SoundFont2} from "soundfont2"

export type MonitoringMapEntry = { uuid: UUID.Bytes, channels: ReadonlyArray<int> }

export type WclapBundleFile = { path: string, bytes: Uint8Array<ArrayBuffer> }
export type WclapBundle = { files: ReadonlyArray<WclapBundleFile> }
// uri "" = plugin not ready, width/height 0 = the plugin names no size
// aspectRatio 0 = free
export type WclapGuiInfo = { uri: string, width: number, height: number, resizable: boolean, aspectRatio: number }
// the size the plugin's clap.gui adjust_size accepted
export type WclapGuiSize = { width: number, height: number }
// one plugin of a bundle's factory, `features` as CLAP lists them ("instrument", "audio-effect", ...)
export type WclapPluginInfo = { clapId: string, name: string, vendor: string, features: ReadonlyArray<string> }
// one clap_param_info of a loaded plugin, values in plain CLAP units, `flags` the clap_param_info_flags bits
export type WclapParamInfo = {
    id: number, name: string, module: string, min: number, max: number, defaultValue: number, value: number, flags: number
}
// one audio input port of a loaded plugin (clap.audio-ports), in port order
export type WclapAudioPort = { name: string, channels: number }
// inputs: the loaded plugin's audio input ports, empty until ready
export type WclapStatus = {
    state: "loading" | "ready" | "failed", message: string, inputs: ReadonlyArray<WclapAudioPort>
}
// a parameter change the plugin reports (its GUI, a preset): 0 = value, 1 = gesture begin, 2 = gesture end
export type WclapParamGesture = 0 | 1 | 2

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
    wclapResizeGui(uuid: UUID.Bytes, width: number, height: number): Promise<WclapGuiSize>
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
    // the loaded plugin's parameter list (once per load) and its own parameter changes
    wclapParams(uuid: string, params: ReadonlyArray<WclapParamInfo>): void
    wclapParam(uuid: string, paramId: number, value: number, gesture: WclapParamGesture): void
    // clap.param-hovered: the parameter under the pointer in the plugin's page, -1 when none
    wclapHovered(uuid: string, paramId: number): void
    // clap.gui request_resize: the plugin asks for another window size (logical pixels)
    wclapResizeGui(uuid: string, width: number, height: number): void
    wclapStatus(uuid: string, status: WclapStatus): void
    // the plugin's state changed, the host answers with `wclapSaveState` between render quanta
    wclapRequestSave(uuid: string): void
    notifyClipSequenceChanges(changes: ClipSequencingUpdates): void
    switchMarkerState(state: Nullable<[UUID.Bytes, int]>): void
    recordingStarted(contextTime: number, position: ppqn, generation: int): void
    ready(): void
}