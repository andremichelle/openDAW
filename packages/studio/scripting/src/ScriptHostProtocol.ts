import {AudioData} from "@opendaw/lib-dsp"
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {Nullable} from "@opendaw/lib-std"
import {DialogField, MixdownOptions, Sample} from "./Api"

export type DialogValue = string | number | boolean
export type DialogRequest = { headline: string, okText: string, fields: ReadonlyArray<DialogField> }

export interface ScriptHostProtocol {
    openProject(buffer: ArrayBufferLike, name?: string): void
    // Replays a script's edits onto the open project as one undoable step. `checksum` is the graph the
    // script started from, so the host can refuse when the project changed in the meantime.
    applyUpdates(updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, checksum: Int8Array): void
    hasProject(): Promise<boolean>
    fetchProject(): Promise<{ buffer: ArrayBuffer, name: string }>
    showInfo(headline: string, message: string): Promise<void>
    // Resolves with one value per field that is no section, in field order, or null when cancelled
    showDialog(request: DialogRequest): Promise<Nullable<ReadonlyArray<DialogValue>>>
    addSample(data: AudioData, name: string): Promise<Sample>
    listSamples(): Promise<ReadonlyArray<Sample>>
    renderMixdown(buffer: ArrayBufferLike, options: MixdownOptions): Promise<AudioData>
    saveFile(buffer: ArrayBuffer, fileName: string, mimeType: string): Promise<void>
}
