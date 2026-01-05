import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {Procedure, unitValue, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"

export interface SampleAPI {
    all(): Promise<ReadonlyArray<Sample>>
    get(uuid: UUID.Bytes): Promise<Sample>
    load(uuid: UUID.Bytes, progress: Procedure<unitValue>): Promise<[AudioData, Sample]>
    upload(arrayBuffer: ArrayBuffer, metaData: SampleMetaData): Promise<void>
    allowsUpload(): boolean
}