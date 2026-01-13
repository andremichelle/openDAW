import {Progress, UUID} from "@moises-ai/lib-std"
import {SoundfontMetaData} from "@moises-ai/studio-adapters"

export interface SoundfontProvider {
    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]>
}