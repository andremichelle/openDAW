import {Terminable, UUID} from "@opendaw/lib-std"
import {SampleLoader} from "./SampleLoader"

export interface SampleLoaderManager {
    getOrCreate(uuid: UUID.Bytes): SampleLoader
    record(loader: SampleLoader): void
    invalidate(uuid: UUID.Bytes): void
    remove(uuid: UUID.Bytes): void
    register(uuid: UUID.Bytes): Terminable
}