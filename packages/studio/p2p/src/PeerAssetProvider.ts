import {Progress, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleMetaData, SoundfontMetaData} from "@opendaw/studio-adapters"
import {type SignalingMessage, AssetSignaling} from "./AssetSignaling"
import {AssetPeerConnection} from "./AssetPeerConnection"
import {AssetZip} from "./AssetZip"
import * as ChunkProtocol from "./ChunkProtocol"

type PendingRequest = {
    readonly uuid: UUID.Bytes
    readonly uuidString: string
    readonly assetType: "sample" | "soundfont"
    readonly progress: Progress.Handler
    readonly resolve: (zipBytes: ArrayBuffer) => void
    readonly reject: (error: Error) => void
}

export class PeerAssetProvider {
    readonly #signaling: AssetSignaling
    readonly #localPeerId: string
    readonly #connections: Map<string, AssetPeerConnection> = new Map()
    readonly #pendingRequests: Map<string, PendingRequest> = new Map()
    readonly #incomingChunks: Map<string, Map<number, Uint8Array>> = new Map()
    readonly #transferMeta: Map<string, {totalChunks: number}> = new Map()
    readonly #knownPeers: Set<string> = new Set()
    readonly #transferringAssets: Set<string> = new Set()

    constructor(signaling: AssetSignaling, localPeerId: string) {
        this.#signaling = signaling
        this.#localPeerId = localPeerId
        this.#signaling.subscribe(message => this.#onSignalingMessage(message))
        console.debug("[P2P:Provider] initialized, peerId:", localPeerId)
    }

    async fetchSample(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[AudioData, SampleMetaData]> {
        console.debug("[P2P:Provider] fetchSample", UUID.toString(uuid))
        const zipBytes = await this.#requestAsset(uuid, "sample", progress)
        console.debug("[P2P:Provider] fetchSample complete, zip size:", zipBytes.byteLength)
        return AssetZip.unpackSample(zipBytes)
    }

    async fetchSoundfont(uuid: UUID.Bytes, progress: Progress.Handler): Promise<[ArrayBuffer, SoundfontMetaData]> {
        console.debug("[P2P:Provider] fetchSoundfont", UUID.toString(uuid))
        const zipBytes = await this.#requestAsset(uuid, "soundfont", progress)
        return AssetZip.unpackSoundfont(zipBytes)
    }

    #requestAsset(uuid: UUID.Bytes, assetType: "sample" | "soundfont", progress: Progress.Handler): Promise<ArrayBuffer> {
        const uuidString = UUID.toString(uuid)
        const {promise, resolve, reject} = Promise.withResolvers<ArrayBuffer>()
        this.#pendingRequests.set(uuidString, {uuid, uuidString, assetType, progress, resolve, reject})
        this.#broadcastRequest(uuidString, assetType)
        return promise
    }

    #broadcastRequest(uuidString: string, assetType: string): void {
        console.debug("[P2P:Provider] broadcasting asset-request for", uuidString, assetType)
        this.#signaling.publish({
            type: "asset-request",
            peerId: this.#localPeerId,
            assets: [{uuid: uuidString, assetType}]
        })
    }

    #rebroadcastPending(): void {
        for (const pending of this.#pendingRequests.values()) {
            if (this.#transferringAssets.has(pending.uuidString)) {continue}
            this.#broadcastRequest(pending.uuidString, pending.assetType)
        }
    }

    #onSignalingMessage(message: SignalingMessage): void {
        const peerId = message.peerId as string | undefined
        if (peerId !== undefined && peerId !== this.#localPeerId && !this.#knownPeers.has(peerId)) {
            this.#knownPeers.add(peerId)
            console.debug("[P2P:Provider] new peer discovered:", peerId, "- rebroadcasting pending requests")
            this.#rebroadcastPending()
        }
        switch (message.type) {
            case "asset-inventory":
                this.#onInventory(message)
                break
            case "rtc-answer":
                this.#onRtcAnswer(message).catch(error => console.warn("[P2P:Provider] error handling rtc-answer:", error))
                break
            case "rtc-ice-candidate":
                this.#onIceCandidate(message).catch(error => console.warn("[P2P:Provider] error handling rtc-ice-candidate:", error))
                break
        }
    }

    #onInventory(message: SignalingMessage): void {
        const peerId = message.peerId as string
        const have = message.have as ReadonlyArray<string>
        console.debug("[P2P:Provider] got inventory from", peerId, "have:", have)
        for (const uuidString of have) {
            const pending = this.#pendingRequests.get(uuidString)
            if (pending === undefined) {continue}
            if (this.#transferringAssets.has(uuidString)) {continue}
            console.debug("[P2P:Provider] initiating transfer for", uuidString, "from peer", peerId)
            this.#initiateTransfer(pending, peerId)
            break
        }
    }

    async #initiateTransfer(pending: PendingRequest, remotePeerId: string): Promise<void> {
        this.#transferringAssets.add(pending.uuidString)
        const connection = new AssetPeerConnection(this.#signaling, this.#localPeerId, remotePeerId)
        this.#connections.set(remotePeerId, connection)
        console.debug("[P2P:Provider] creating WebRTC offer to", remotePeerId)
        const channel = await connection.createOffer()
        console.debug("[P2P:Provider] offer created, waiting for data channel open")
        channel.onmessage = (event: MessageEvent) => {
            this.#onDataChannelMessage(pending, event.data as ArrayBuffer)
        }
        channel.onerror = (event) => {
            console.error("[P2P:Provider] data channel error:", event)
            this.#transferringAssets.delete(pending.uuidString)
            this.#pendingRequests.delete(pending.uuidString)
            pending.reject(new Error(`Data channel error for asset ${pending.uuidString}`))
        }
        channel.onclose = () => {
            console.debug("[P2P:Provider] data channel closed")
        }
        channel.onopen = () => {
            console.debug("[P2P:Provider] data channel open, sending transfer-request for", pending.uuidString)
            channel.send(JSON.stringify({
                type: "transfer-request",
                uuid: pending.uuidString,
                assetType: pending.assetType
            }))
        }
    }

    #onDataChannelMessage(pending: PendingRequest, buffer: ArrayBuffer): void {
        const message = ChunkProtocol.decode(buffer)
        switch (message.msgType) {
            case ChunkProtocol.MsgType.TransferStart: {
                const meta = JSON.parse(new TextDecoder().decode(message.payload))
                console.debug("[P2P:Provider] transfer-start for", pending.uuidString, "totalChunks:", meta.totalChunks, "zipSize:", meta.zipSize)
                this.#transferMeta.set(pending.uuidString, {totalChunks: meta.totalChunks})
                this.#incomingChunks.set(pending.uuidString, new Map())
                break
            }
            case ChunkProtocol.MsgType.ChunkData: {
                const chunks = this.#incomingChunks.get(pending.uuidString)
                if (chunks === undefined) {break}
                chunks.set(message.chunkNum, message.payload)
                const meta = this.#transferMeta.get(pending.uuidString)
                if (meta !== undefined) {
                    const progress = chunks.size / meta.totalChunks
                    if (chunks.size % 10 === 0 || chunks.size === meta.totalChunks) {
                        console.debug("[P2P:Provider] chunk", chunks.size, "/", meta.totalChunks, `(${(progress * 100).toFixed(0)}%)`)
                    }
                    pending.progress(progress)
                }
                break
            }
            case ChunkProtocol.MsgType.TransferComplete: {
                console.debug("[P2P:Provider] transfer-complete for", pending.uuidString)
                const chunks = this.#incomingChunks.get(pending.uuidString)
                const meta = this.#transferMeta.get(pending.uuidString)
                if (chunks === undefined || meta === undefined) {break}
                const ordered: Array<Uint8Array> = []
                for (let index = 0; index < meta.totalChunks; index++) {
                    const chunk = chunks.get(index)
                    if (chunk === undefined) {
                        pending.reject(new Error(`Missing chunk ${index} for asset ${pending.uuidString}`))
                        return
                    }
                    ordered.push(chunk)
                }
                const zipBytes = ChunkProtocol.reassemble(ordered)
                console.debug("[P2P:Provider] reassembled zip:", zipBytes.byteLength, "bytes")
                this.#incomingChunks.delete(pending.uuidString)
                this.#transferMeta.delete(pending.uuidString)
                this.#transferringAssets.delete(pending.uuidString)
                this.#pendingRequests.delete(pending.uuidString)
                pending.progress(1.0)
                pending.resolve(zipBytes)
                break
            }
        }
    }

    async #onRtcAnswer(message: SignalingMessage): Promise<void> {
        const peerId = message.peerId as string
        const sdp = message.sdp as string
        const connection = this.#connections.get(peerId)
        if (connection === undefined) {
            console.debug("[P2P:Provider] no connection for rtc-answer from", peerId)
            return
        }
        console.debug("[P2P:Provider] handling rtc-answer from", peerId)
        await connection.handleAnswer(sdp)
    }

    async #onIceCandidate(message: SignalingMessage): Promise<void> {
        const peerId = message.peerId as string
        if (message.targetPeerId !== this.#localPeerId) {return}
        const connection = this.#connections.get(peerId)
        if (connection === undefined) {return}
        await connection.handleIceCandidate(message.candidate as RTCIceCandidateInit)
    }

    terminate(): void {
        console.debug("[P2P:Provider] terminating")
        for (const connection of this.#connections.values()) {
            connection.terminate()
        }
        this.#connections.clear()
        for (const pending of this.#pendingRequests.values()) {
            pending.reject(new Error("P2P session terminated"))
        }
        this.#pendingRequests.clear()
        this.#incomingChunks.clear()
        this.#transferMeta.clear()
        this.#transferringAssets.clear()
    }
}
