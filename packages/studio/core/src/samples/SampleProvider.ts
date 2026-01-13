import {Progress, UUID} from "@moises-ai/lib-std"
import {SampleMetaData} from "@moises-ai/studio-adapters"
import {AudioData} from "@moises-ai/lib-dsp"

export interface SampleProvider {
    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]>
}