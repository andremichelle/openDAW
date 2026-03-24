import {UUID} from "@opendaw/lib-std"
import {SampleMetaData, SoundfontMetaData} from "@opendaw/studio-adapters"
import {AssetSignaling, type SignalingMessage} from "./AssetSignaling"
import {AssetPeerConnection} from "./AssetPeerConnection"
import * as ChunkProtocol from "./ChunkProtocol"
import {AssetZip} from "./AssetZip"

export type AssetReader = {
    readonly hasSample: (uuid: UUID.Bytes) => Promise<boolean>
    readonly hasSoundfont: (uuid: UUID.Bytes) => Promise<boolean>
    readonly readSample: (uuid: UUID.Bytes) => Promise<[ArrayBuffer, SampleMetaData]>
    readonly readSoundfont: (uuid: UUID.Bytes) => Promise<[ArrayBuffer, SoundfontMetaData]>
}

export class AssetServer {
    readonly #signaling: AssetSignaling
    readonly #localPeerId: string
    readonly #assetReader: AssetReader
    readonly #connections: Map<string, AssetPeerConnection> = new Map()

    constructor(signaling: AssetSignaling, localPeerId: string, assetReader: AssetReader) {
        this.#signaling = signaling
        this.#localPeerId = localPeerId
        this.#assetReader = assetReader
        this.#signaling.subscribe(message => this.#onSignalingMessage(message))
        console.debug("[P2P:Server] initialized, peerId:", localPeerId)
    }

    #onSignalingMessage(message: SignalingMessage): void {
        console.debug("[P2P:Server] received signaling message:", message.type, "from", message.peerId)
        switch (message.type) {
            case "asset-request":
                this.#onAssetRequest(message).catch(error => console.warn("[P2P:Server] error handling asset-request:", error))
                break
            case "rtc-offer":
                this.#onRtcOffer(message).catch(error => console.warn("[P2P:Server] error handling rtc-offer:", error))
                break
            case "rtc-ice-candidate":
                this.#onIceCandidate(message).catch(error => console.warn("[P2P:Server] error handling rtc-ice-candidate:", error))
                break
        }
    }

    async #onAssetRequest(message: SignalingMessage): Promise<void> {
        const peerId = message.peerId as string
        const assets = message.assets as ReadonlyArray<{uuid: string, assetType: string}>
        console.debug("[P2P:Server] asset-request from", peerId, "for", assets.length, "assets")
        const have: Array<string> = []
        for (const asset of assets) {
            try {
                const uuid = UUID.parse(asset.uuid) as UUID.Bytes
                console.debug("[P2P:Server] checking", asset.assetType, asset.uuid)
                if (asset.assetType === "sample" && await this.#assetReader.hasSample(uuid)) {
                    console.debug("[P2P:Server] have sample", asset.uuid)
                    have.push(asset.uuid)
                } else if (asset.assetType === "soundfont" && await this.#assetReader.hasSoundfont(uuid)) {
                    console.debug("[P2P:Server] have soundfont", asset.uuid)
                    have.push(asset.uuid)
                } else {
                    console.debug("[P2P:Server] do NOT have", asset.assetType, asset.uuid)
                }
            } catch (error: unknown) {
                console.warn("[P2P:Server] error checking asset", asset.uuid, error)
            }
        }
        if (have.length > 0) {
            console.debug("[P2P:Server] responding with inventory:", have, "to", peerId)
            this.#signaling.publish({
                type: "asset-inventory",
                peerId: this.#localPeerId,
                targetPeerId: peerId,
                have
            })
        } else {
            console.debug("[P2P:Server] no matching assets for", peerId)
        }
    }

    async #onRtcOffer(message: SignalingMessage): Promise<void> {
        const peerId = message.peerId as string
        const targetPeerId = message.targetPeerId as string
        if (targetPeerId !== this.#localPeerId) {
            console.debug("[P2P:Server] rtc-offer not for us (target:", targetPeerId, ")")
            return
        }
        console.debug("[P2P:Server] handling rtc-offer from", peerId)
        const sdp = message.sdp as string
        const connection = new AssetPeerConnection(this.#signaling, this.#localPeerId, peerId)
        this.#connections.set(peerId, connection)
        const channel = await connection.handleOffer(sdp)
        console.debug("[P2P:Server] data channel established with", peerId)
        channel.onmessage = (event: MessageEvent) => {
            console.debug("[P2P:Server] data channel message received from", peerId)
            this.#onChannelMessage(connection, channel, event.data as string)
        }
    }

    async #onChannelMessage(connection: AssetPeerConnection, channel: RTCDataChannel, data: string): Promise<void> {
        const request = JSON.parse(data)
        if (request.type !== "transfer-request") {
            console.debug("[P2P:Server] unknown channel message type:", request.type)
            return
        }
        console.debug("[P2P:Server] transfer-request for", request.uuid, request.assetType)
        const uuid = UUID.parse(request.uuid) as UUID.Bytes
        const assetType = request.assetType as string
        let zipBytes: ArrayBuffer
        if (assetType === "sample") {
            console.debug("[P2P:Server] reading sample from OPFS...")
            const [wavBytes, meta] = await this.#assetReader.readSample(uuid)
            console.debug("[P2P:Server] sample read, wav size:", wavBytes.byteLength, "packing zip...")
            zipBytes = await AssetZip.packSample(wavBytes, meta)
        } else {
            console.debug("[P2P:Server] reading soundfont from OPFS...")
            const [sf2Bytes, meta] = await this.#assetReader.readSoundfont(uuid)
            console.debug("[P2P:Server] soundfont read, sf2 size:", sf2Bytes.byteLength, "packing zip...")
            zipBytes = await AssetZip.packSoundfont(sf2Bytes, meta)
        }
        const chunks = ChunkProtocol.split(zipBytes)
        console.debug("[P2P:Server] sending", chunks.length, "chunks, zip size:", zipBytes.byteLength)
        const startPayload = new TextEncoder().encode(JSON.stringify({
            totalChunks: chunks.length,
            zipSize: zipBytes.byteLength
        }))
        await connection.sendWithBackpressure(channel,
            ChunkProtocol.encode(ChunkProtocol.MsgType.TransferStart, uuid, 0, startPayload))
        for (let index = 0; index < chunks.length; index++) {
            await connection.sendWithBackpressure(channel,
                ChunkProtocol.encode(ChunkProtocol.MsgType.ChunkData, uuid, index, chunks[index]))
        }
        await connection.sendWithBackpressure(channel,
            ChunkProtocol.encode(ChunkProtocol.MsgType.TransferComplete, uuid, 0, new Uint8Array(0)))
        console.debug("[P2P:Server] transfer complete for", request.uuid)
    }

    async #onIceCandidate(message: SignalingMessage): Promise<void> {
        const peerId = message.peerId as string
        if (message.targetPeerId !== this.#localPeerId) {return}
        const connection = this.#connections.get(peerId)
        if (connection === undefined) {return}
        await connection.handleIceCandidate(message.candidate as RTCIceCandidateInit)
    }

    terminate(): void {
        console.debug("[P2P:Server] terminating")
        for (const connection of this.#connections.values()) {
            connection.terminate()
        }
        this.#connections.clear()
    }
}
