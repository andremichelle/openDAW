import {Option, Progress, UUID} from "@opendaw/lib-std"
import {SoundfontMetaData} from "@opendaw/studio-adapters"

export interface SoundfontProvider {
    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]>
}

export class ChainedSoundfontProvider implements SoundfontProvider {
    readonly #cloud: SoundfontProvider

    #peer: Option<SoundfontProvider> = Option.None

    constructor(cloud: SoundfontProvider) {
        this.#cloud = cloud
    }

    attachPeer(provider: SoundfontProvider): void {this.#peer = Option.wrap(provider)}
    detachPeer(): void {this.#peer = Option.None}

    async fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]> {
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
