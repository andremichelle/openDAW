import {AudioData} from "@opendaw/lib-dsp"
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {Sample} from "./Api"

export interface ScriptHostProtocol {
    openProject(buffer: ArrayBufferLike, name?: string): void
    // Replays a script's edits onto the open project as one undoable step. `checksum` is the graph the
    // script started from, so the host can refuse when the project changed in the meantime.
    applyUpdates(updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, checksum: Int8Array): void
    hasProject(): Promise<boolean>
    fetchProject(): Promise<{ buffer: ArrayBuffer, name: string }>
    showInfo(headline: string, message: string): Promise<void>
    addSample(data: AudioData, name: string): Promise<Sample>
    listSamples(): Promise<ReadonlyArray<Sample>>
}
