import {isDefined, Optional} from "@opendaw/lib-std"
import {AssetSource} from "./AssetTransport"
import {AssetMeta} from "../types"
import {PeerManager} from "../webrtc/PeerManager"

type WebRTCAssetSourceOptions = {
    readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024

export class WebRTCAssetSource implements AssetSource {
    readonly name = "webrtc"
    readonly #peerManager: PeerManager
    readonly #timeoutMs: number

    constructor(peerManager: PeerManager, options?: WebRTCAssetSourceOptions) {
        this.#peerManager = peerManager
        this.#timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    }

    async resolve(assetId: string): Promise<Optional<ArrayBuffer>> {
        const peerIds = this.#peerManager.peerIds
        if (peerIds.length === 0) {return undefined}
        for (const peerId of peerIds) {
            const result = await this.#requestFromPeer(peerId, assetId)
            if (isDefined(result)) {return result}
        }
        return undefined
    }

    async publish(_assetId: string, _data: ArrayBuffer, _meta: AssetMeta): Promise<void> {
        // WebRTC assets are pulled by requesters, not pushed
    }

    async #requestFromPeer(peerId: string, assetId: string): Promise<Optional<ArrayBuffer>> {
        const channel = this.#peerManager.getDataChannel(peerId)
        if (!isDefined(channel) || channel.readyState !== "open") {return undefined}
        return new Promise<Optional<ArrayBuffer>>((resolve) => {
            const timeout = setTimeout(() => {
                cleanup()
                resolve(undefined)
            }, this.#timeoutMs)
            const onMessage = (event: MessageEvent) => {
                if (typeof event.data !== "string") {return}
                let message: Record<string, unknown>
                try {
                    message = JSON.parse(event.data) as Record<string, unknown>
                } catch {
                    return
                }
                if (message.assetId !== assetId) {return}
                cleanup()
                if (message.type === "response" && Array.isArray(message.data)) {
                    if ((message.data as Array<unknown>).length > MAX_PAYLOAD_BYTES) {
                        resolve(undefined)
                        return
                    }
                    resolve(Uint8Array.from(message.data as Array<number>).buffer)
                } else {
                    resolve(undefined)
                }
            }
            const cleanup = () => {
                clearTimeout(timeout)
                channel.removeEventListener("message", onMessage)
            }
            channel.addEventListener("message", onMessage)
            try {
                channel.send(JSON.stringify({type: "request", assetId}))
            } catch {
                cleanup()
                resolve(undefined)
            }
        })
    }
}
