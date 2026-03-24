import {isDefined, Optional, Progress, UUID} from "@opendaw/lib-std"
import {SoundfontMetaData} from "@opendaw/studio-adapters"

export interface SoundfontProvider {
    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]>
}

export class ChainedSoundfontProvider implements SoundfontProvider {
    readonly #cloud: SoundfontProvider
    #peer: Optional<SoundfontProvider>

    constructor(cloud: SoundfontProvider) {
        this.#cloud = cloud
        this.#peer = undefined
    }

    attachPeer(provider: SoundfontProvider): void {this.#peer = provider}
    detachPeer(): void {this.#peer = undefined}

    async fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]> {
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
