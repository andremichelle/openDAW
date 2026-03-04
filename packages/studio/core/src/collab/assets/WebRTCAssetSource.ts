import {isDefined, Optional} from "@opendaw/lib-std"
import {AssetSource} from "./AssetTransport"
import {AssetMeta} from "../types"
import {PeerManager} from "../webrtc/PeerManager"

type WebRTCAssetSourceOptions = {
    readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

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
                try {
                    const message = JSON.parse(event.data)
                    if (message.assetId !== assetId) {return}
                    cleanup()
                    if (message.type === "response" && Array.isArray(message.data)) {
                        resolve(Uint8Array.from(message.data).buffer)
                    } else {
                        resolve(undefined)
                    }
                } catch {
                    cleanup()
                    resolve(undefined)
                }
            }
            const cleanup = () => {
                clearTimeout(timeout)
                channel.removeEventListener("message", onMessage)
            }
            channel.addEventListener("message", onMessage)
            channel.send(JSON.stringify({type: "request", assetId}))
        })
    }
}
