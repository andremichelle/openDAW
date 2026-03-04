import {Optional} from "@opendaw/lib-std"
import {AssetSource} from "./AssetTransport"
import {AssetMeta} from "../types"
import {PeerManager} from "../webrtc/PeerManager"

export class WebRTCAssetSource implements AssetSource {
    readonly name = "webrtc"
    readonly #peerManager: PeerManager

    constructor(peerManager: PeerManager) {
        this.#peerManager = peerManager
    }

    async resolve(assetId: string): Promise<Optional<ArrayBuffer>> {
        const peerIds = this.#peerManager.peerIds
        if (peerIds.length === 0) {return undefined}
        for (const peerId of peerIds) {
            const result = await this.#requestFromPeer(peerId, assetId)
            if (result !== undefined) {return result}
        }
        return undefined
    }

    async publish(_assetId: string, _data: ArrayBuffer, _meta: AssetMeta): Promise<void> {
        // WebRTC assets are pulled by requesters, not pushed
    }

    async #requestFromPeer(_peerId: string, _assetId: string): Promise<Optional<ArrayBuffer>> {
        // TODO: Implement WebRTC data channel request/response protocol
        // 1. Get data channel from PeerManager
        // 2. Send AssetRequest message
        // 3. Wait for AssetResponse or AssetNotFound with timeout
        return undefined
    }
}
