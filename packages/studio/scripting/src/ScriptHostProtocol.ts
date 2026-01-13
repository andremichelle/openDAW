import {Sample} from "@moises-ai/studio-adapters"
import {AudioData} from "@moises-ai/lib-dsp"

export interface ScriptHostProtocol {
    openProject(buffer: ArrayBufferLike, name?: string): void

    fetchProject(): Promise<{ buffer: ArrayBuffer, name: string }>

    addSample(data: AudioData, name: string): Promise<Sample>
}