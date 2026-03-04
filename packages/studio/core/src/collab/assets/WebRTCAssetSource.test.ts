import {describe, expect, it} from "vitest"
import {WebRTCAssetSource} from "./WebRTCAssetSource"
import {PeerManager} from "../webrtc/PeerManager"

globalThis.RTCPeerConnection = class MockRTCPeerConnection {
    close() {}
} as any

describe("WebRTCAssetSource", () => {
    it("has name 'webrtc'", () => {
        const peerManager = new PeerManager()
        const source = new WebRTCAssetSource(peerManager)
        expect(source.name).toBe("webrtc")
    })
    it("returns undefined when no peers are connected", async () => {
        const peerManager = new PeerManager()
        const source = new WebRTCAssetSource(peerManager)
        const result = await source.resolve("asset-1")
        expect(result).toBeUndefined()
    })
    it("publish is a no-op (assets are pulled, not pushed)", async () => {
        const peerManager = new PeerManager()
        const source = new WebRTCAssetSource(peerManager)
        await expect(source.publish("a", new ArrayBuffer(0), {
            assetId: "a", name: "test", sizeBytes: 0, mimeType: "audio/wav", s3Url: undefined
        })).resolves.toBeUndefined()
    })
})
