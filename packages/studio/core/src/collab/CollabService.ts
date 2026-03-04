import {isDefined, Optional, Terminable, Terminator} from "@opendaw/lib-std"
import {CollabConfig} from "./types"
import {RoomService} from "./RoomService"
import {PresenceService} from "./PresenceService"
import {PeerManager} from "./webrtc/PeerManager"
import {AssetSource, AssetTransportChain} from "./assets/AssetTransport"
import {OpfsAssetSource} from "./assets/OpfsAssetSource"
import {S3AssetSource} from "./assets/S3AssetSource"
import {WebRTCAssetSource} from "./assets/WebRTCAssetSource"
import {StdbConnection} from "./stdb/StdbConnection"

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
    readonly connection: StdbConnection
    #state: CollabState = CollabState.Disconnected
    #roomId: Optional<string> = undefined

    constructor(config: CollabConfig) {
        this.#config = config
        this.room = new RoomService(config)
        this.presence = new PresenceService()
        this.peerManager = new PeerManager()
        const sources: Array<AssetSource> = [new OpfsAssetSource()]
        if (isDefined(config.s3)) {
            sources.push(new S3AssetSource(config.s3))
        }
        sources.push(new WebRTCAssetSource(this.peerManager))
        this.assets = new AssetTransportChain(sources)
        this.connection = new StdbConnection({
            endpoint: config.endpoint,
            databaseName: "opendaw",
        })
        this.#terminator.own(this.presence)
        this.#terminator.own(this.peerManager)
        this.#terminator.own(this.connection)
    }

    get state(): CollabState {return this.#state}
    get roomId(): Optional<string> {return this.#roomId}

    createRoom(): void {
        this.#roomId = this.room.generateRoomId()
        this.#state = CollabState.Connecting
        this.connection.connect()
    }

    joinRoom(roomId: string): void {
        this.#roomId = roomId
        this.#state = CollabState.Connecting
        this.connection.connect()
    }

    leaveRoom(): void {
        this.#roomId = undefined
        this.#state = CollabState.Disconnected
        this.connection.disconnect()
        this.presence.clear()
    }

    terminate(): void {
        this.#roomId = undefined
        this.#state = CollabState.Disconnected
        this.#terminator.terminate()
    }
}
