import {Terminable} from "@opendaw/lib-std"
import {AssetSignaling, type SignalingSocket} from "./AssetSignaling"
import {AssetServer, type AssetReader} from "./AssetServer"
import {PeerAssetProvider} from "./PeerAssetProvider"
import {ChainedSampleProvider} from "./ChainedSampleProvider"
import {ChainedSoundfontProvider} from "./ChainedSoundfontProvider"

export type P2PSessionContext = {
    readonly chainedSampleProvider: ChainedSampleProvider
    readonly chainedSoundfontProvider: ChainedSoundfontProvider
    readonly createSocket: (url: string) => SignalingSocket
    readonly assetReader: AssetReader
    readonly localPeerId: string
}

export class P2PSession implements Terminable {
    readonly #context: P2PSessionContext
    readonly #signaling: AssetSignaling
    readonly #provider: PeerAssetProvider
    readonly #server: AssetServer
    #terminated: boolean = false

    constructor(context: P2PSessionContext, roomName: string, serverUrl: string) {
        this.#context = context
        const socket = context.createSocket(`${serverUrl}/signaling`)
        this.#signaling = new AssetSignaling(socket, `assets:${roomName}`)
        this.#provider = new PeerAssetProvider(this.#signaling, context.localPeerId)
        this.#server = new AssetServer(this.#signaling, context.localPeerId, context.assetReader)
        context.chainedSampleProvider.attachPeer({
            fetch: (uuid, progress) => this.#provider.fetchSample(uuid, progress)
        })
        context.chainedSoundfontProvider.attachPeer({
            fetch: (uuid, progress) => this.#provider.fetchSoundfont(uuid, progress)
        })
    }

    get signaling(): AssetSignaling {return this.#signaling}

    terminate(): void {
        if (this.#terminated) {return}
        this.#terminated = true
        this.#context.chainedSampleProvider.detachPeer()
        this.#context.chainedSoundfontProvider.detachPeer()
        this.#provider.terminate()
        this.#server.terminate()
        this.#signaling.terminate()
    }
}
