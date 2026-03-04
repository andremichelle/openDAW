import {describe, expect, it, vi} from "vitest"
import {WebRTCAssetSource} from "./WebRTCAssetSource"
import {PeerManager} from "../webrtc/PeerManager"

const createMockChannel = () => {
    const listeners = new Map<string, Function>()
    return {
        readyState: "open" as RTCDataChannelState,
        send: vi.fn(),
        addEventListener: vi.fn((event: string, handler: Function) => listeners.set(event, handler)),
        removeEventListener: vi.fn(),
        close: vi.fn(),
        _trigger: (event: string, data: any) => listeners.get(event)?.(data),
    }
}

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
    it("requests asset from peer via data channel", async () => {
        const peerManager = new PeerManager()
        const channel = createMockChannel()
        peerManager.addPeer("peer-1")
        peerManager.setDataChannel("peer-1", channel as any)
        const source = new WebRTCAssetSource(peerManager, {timeoutMs: 500})
        const resolvePromise = source.resolve("asset-1")
        const sendCall = channel.send.mock.calls[0]
        expect(sendCall).toBeDefined()
        const request = JSON.parse(sendCall[0])
        expect(request.type).toBe("request")
        expect(request.assetId).toBe("asset-1")
        const responseData = new Uint8Array([1, 2, 3, 4]).buffer
        channel._trigger("message", {data: JSON.stringify({
            type: "response",
            assetId: "asset-1",
            data: Array.from(new Uint8Array(responseData)),
        })})
        const result = await resolvePromise
        expect(result).toBeDefined()
        expect(new Uint8Array(result!)).toEqual(new Uint8Array([1, 2, 3, 4]))
    })
    it("returns undefined when peer reports not-found", async () => {
        const peerManager = new PeerManager()
        const channel = createMockChannel()
        peerManager.addPeer("peer-1")
        peerManager.setDataChannel("peer-1", channel as any)
        const source = new WebRTCAssetSource(peerManager, {timeoutMs: 500})
        const resolvePromise = source.resolve("missing-asset")
        channel._trigger("message", {data: JSON.stringify({
            type: "not-found",
            assetId: "missing-asset",
        })})
        const result = await resolvePromise
        expect(result).toBeUndefined()
    })
    it("times out if peer does not respond", async () => {
        const peerManager = new PeerManager()
        const channel = createMockChannel()
        peerManager.addPeer("peer-1")
        peerManager.setDataChannel("peer-1", channel as any)
        const source = new WebRTCAssetSource(peerManager, {timeoutMs: 50})
        const result = await source.resolve("slow-asset")
        expect(result).toBeUndefined()
    })
})
