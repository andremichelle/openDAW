import {Terminable, Terminator} from "@opendaw/lib-std"
import {CollabConfig} from "./types"
import {RoomService} from "./RoomService"
import {PresenceService} from "./PresenceService"
import {PeerManager} from "./webrtc/PeerManager"
import {AssetTransportChain} from "./assets/AssetTransport"
import {OpfsAssetSource} from "./assets/OpfsAssetSource"
import {WebRTCAssetSource} from "./assets/WebRTCAssetSource"

export enum CollabState {
    Disconnected = "disconnected",
    Connecting = "connecting",
    Connected = "connected",
}

export class CollabService implements Terminable {
    readonly #terminator = new Terminator()
    readonly #config: CollabConfig
    readonly room: RoomService
    readonly presence: PresenceService
    readonly peerManager: PeerManager
    readonly assets: AssetTransportChain
    #state: CollabState = CollabState.Disconnected

    constructor(config: CollabConfig) {
        this.#config = config
        this.room = new RoomService(config)
        this.presence = new PresenceService()
        this.peerManager = new PeerManager()
        this.assets = new AssetTransportChain([
            new OpfsAssetSource(),
            new WebRTCAssetSource(this.peerManager),
        ])
        this.#terminator.ownAll(this.presence, this.peerManager)
    }

    get state(): CollabState {
        return this.#state
    }

    terminate(): void {
        this.#state = CollabState.Disconnected
        this.#terminator.terminate()
    }
}
