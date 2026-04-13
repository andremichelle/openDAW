import {Progress, UUID} from "@opendaw/lib-std"

export interface Fetcher<RESULT> {
    fetch(uuid: UUID.Bytes, progress: Progress.Handler): Promise<RESULT>
}

export interface ChainedProvider<PEER, RESULT> extends Fetcher<RESULT> {
    attachPeer(peer: PEER): void
    detachPeer(): void
}