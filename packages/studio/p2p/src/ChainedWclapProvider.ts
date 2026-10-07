import {Option, Progress, UUID} from "@opendaw/lib-std"
import {type Fetcher} from "./ChainedProvider"

export type WclapFetcher = Fetcher<ArrayBuffer>

// WebCLAP bundles live only in a user's OPFS, so a missing one can only come from a peer in the room
export class ChainedWclapProvider implements WclapFetcher {
    #peer: Option<WclapFetcher> = Option.None

    attachPeer(provider: WclapFetcher): void {this.#peer = Option.wrap(provider)}
    detachPeer(): void {this.#peer = Option.None}

    async fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<ArrayBuffer> {
        return this.#peer.match({
            none: () => Promise.reject(new Error(`WebCLAP bundle ${UUID.toString(uuid)} is not available`)),
            some: peer => peer.fetch(uuid, progress)
        })
    }
}
