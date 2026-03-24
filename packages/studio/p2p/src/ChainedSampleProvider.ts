import {Option, Progress, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleMetaData} from "@opendaw/studio-adapters"

export interface SampleProvider {
    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]>
}

export class ChainedSampleProvider implements SampleProvider {
    readonly #cloud: SampleProvider

    #peer: Option<SampleProvider> = Option.None

    constructor(cloud: SampleProvider) {
        this.#cloud = cloud
    }

    attachPeer(provider: SampleProvider): void {this.#peer = Option.wrap(provider)}
    detachPeer(): void {this.#peer = Option.None}

    async fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]> {
        try {
            return await this.#cloud.fetch(uuid, progress)
        } catch (cloudError: unknown) {
            return this.#peer.match({
                none: () => {throw cloudError},
                some: peer => peer.fetch(uuid, progress)
            })
        }
    }
}
