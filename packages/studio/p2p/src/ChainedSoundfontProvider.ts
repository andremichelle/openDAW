import {Option, Progress, UUID} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {SoundfontMetaData} from "@moises-ai/studio-adapters"
import {type Fetcher} from "./ChainedProvider"

type SoundfontResult = [ArrayBuffer, SoundfontMetaData]
export type SoundfontFetcher = Fetcher<SoundfontResult>

export class ChainedSoundfontProvider implements SoundfontFetcher {
    readonly #cloud: SoundfontFetcher

    #peer: Option<SoundfontFetcher> = Option.None

    constructor(cloud: SoundfontFetcher) {
        this.#cloud = cloud
    }

    attachPeer(provider: SoundfontFetcher): void {this.#peer = Option.wrap(provider)}
    detachPeer(): void {this.#peer = Option.None}

    async fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<SoundfontResult> {
        const result = await Promises.tryCatch(this.#cloud.fetch(uuid, progress))
        if (result.status === "resolved") {return result.value}
        return this.#peer.match({
            none: () => {throw result.error},
            some: peer => peer.fetch(uuid, progress)
        })
    }
}
