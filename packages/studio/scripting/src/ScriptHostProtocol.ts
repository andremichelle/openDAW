import {AudioData} from "@opendaw/lib-dsp"
import {Sample} from "./Api"

export interface ScriptHostProtocol {
    openProject(buffer: ArrayBufferLike, name?: string): void
    hasProject(): Promise<boolean>
    fetchProject(): Promise<{ buffer: ArrayBuffer, name: string }>
    showInfo(headline: string, message: string): Promise<void>
    addSample(data: AudioData, name: string): Promise<Sample>
    listSamples(): Promise<ReadonlyArray<Sample>>
}
