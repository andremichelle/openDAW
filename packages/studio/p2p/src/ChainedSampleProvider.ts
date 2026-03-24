import {isDefined, Optional, Progress, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleMetaData} from "@opendaw/studio-adapters"

export interface SampleProvider {
    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]>
}

export class ChainedSampleProvider implements SampleProvider {
    readonly #cloud: SampleProvider
    #peer: Optional<SampleProvider>

    constructor(cloud: SampleProvider) {
        this.#cloud = cloud
        this.#peer = undefined
    }

    attachPeer(provider: SampleProvider): void {this.#peer = provider}
    detachPeer(): void {this.#peer = undefined}

    async fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]> {
        try {
            return await this.#cloud.fetch(uuid, progress)
        } catch (cloudError: unknown) {
            if (isDefined(this.#peer)) {
                return this.#peer.fetch(uuid, progress)
            }
            throw cloudError
        }
    }
}
