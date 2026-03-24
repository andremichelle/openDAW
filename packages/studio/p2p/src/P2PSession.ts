import {Terminable} from "@opendaw/lib-std"
import {AssetSignaling, type SignalingSocket} from "./AssetSignaling"
import {ChainedSampleProvider} from "./ChainedSampleProvider"
import {ChainedSoundfontProvider} from "./ChainedSoundfontProvider"

export type P2PSessionContext = {
    readonly chainedSampleProvider: ChainedSampleProvider
    readonly chainedSoundfontProvider: ChainedSoundfontProvider
    readonly createSocket: (url: string) => SignalingSocket
}

export class P2PSession implements Terminable {
    readonly #context: P2PSessionContext
    readonly #signaling: AssetSignaling
    #terminated: boolean = false

    constructor(context: P2PSessionContext, roomName: string, serverUrl: string) {
        this.#context = context
        const socket = context.createSocket(`${serverUrl}/signaling`)
        this.#signaling = new AssetSignaling(socket, `assets:${roomName}`)
        // TODO: attach PeerSampleProvider and PeerSoundfontProvider
        // context.chainedSampleProvider.attachPeer(peerSampleProvider)
        // context.chainedSoundfontProvider.attachPeer(peerSoundfontProvider)
    }

    get signaling(): AssetSignaling {return this.#signaling}

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        this.#context.chainedSampleProvider.detachPeer()
        this.#context.chainedSoundfontProvider.detachPeer()
        this.#signaling.terminate()
    }
}
