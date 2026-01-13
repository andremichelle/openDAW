import {Sample, SampleMetaData} from "@moises-ai/studio-adapters"
import {Procedure, unitValue, UUID} from "@moises-ai/lib-std"
import {AudioData} from "@moises-ai/lib-dsp"

export interface SampleAPI {
    all(): Promise<ReadonlyArray<Sample>>
    get(uuid: UUID.Bytes): Promise<Sample>
    load(uuid: UUID.Bytes, progress: Procedure<unitValue>): Promise<[AudioData, Sample]>
    upload(arrayBuffer: ArrayBuffer, metaData: SampleMetaData): Promise<void>
    allowsUpload(): boolean
}