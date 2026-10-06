import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AssetSignaling, type SignalingSocket} from "../AssetSignaling"
import {AssetPeerConnection} from "../AssetPeerConnection"
import {PeerAssetProvider, WCLAP_DISCOVERY_TIMEOUT_MS} from "../PeerAssetProvider"

// A WebCLAP bundle has no cloud source: when no peer in the room holds it the request must fail, otherwise the
// device stays "loading" and the engine's queryLoadingComplete (exports, offline render) never resolves.

type MockSocket = SignalingSocket & { simulateMessage: (data: string) => void }

const createMockSocket = (): MockSocket => ({
    readyState: 1,
    send() {},
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    simulateMessage(data: string) {
        if (this.onmessage !== null) {this.onmessage({data})}
    }
})

const publishEnvelope = (topic: string, message: Record<string, unknown>): string =>
    JSON.stringify({type: "publish", topic, data: message})

const settled = (promise: Promise<unknown>): { state: "pending" | "resolved" | "rejected" } => {
    const result: { state: "pending" | "resolved" | "rejected" } = {state: "pending"}
    promise.then(() => {result.state = "resolved"}, () => {result.state = "rejected"})
    return result
}

describe("WebCLAP discovery timeout", () => {
    beforeEach(() => {vi.useFakeTimers()})
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it("rejects a bundle request when no peer reports holding it", async () => {
        const provider = new PeerAssetProvider(new AssetSignaling(createMockSocket(), "assets:room"), "local-peer")
        const request = settled(provider.fetchWclap(UUID.generate(), () => {}))
        await vi.advanceTimersByTimeAsync(WCLAP_DISCOVERY_TIMEOUT_MS - 1)
        expect(request.state).toBe("pending")
        await vi.advanceTimersByTimeAsync(1)
        expect(request.state).toBe("rejected")
        provider.terminate()
    })

    it("keeps the request once a peer holding the bundle answered", async () => {
        vi.spyOn(AssetPeerConnection.prototype, "createOffer").mockImplementation(() => new Promise(() => {}))
        const socket = createMockSocket()
        const provider = new PeerAssetProvider(new AssetSignaling(socket, "assets:room"), "local-peer")
        const uuid = UUID.generate()
        const request = settled(provider.fetchWclap(uuid, () => {}))
        socket.simulateMessage(publishEnvelope("assets:room", {
            type: "asset-inventory", peerId: "remote-peer", targetPeerId: "local-peer", have: [UUID.toString(uuid)]
        }))
        await vi.advanceTimersByTimeAsync(WCLAP_DISCOVERY_TIMEOUT_MS * 2)
        expect(request.state).toBe("pending")
        provider.terminate()
    })

    it("leaves sample, soundfont and cover requests without a discovery timeout", async () => {
        const provider = new PeerAssetProvider(new AssetSignaling(createMockSocket(), "assets:room"), "local-peer")
        const requests = [
            settled(provider.fetchSample(UUID.generate(), () => {})),
            settled(provider.fetchSoundfont(UUID.generate(), () => {})),
            settled(provider.fetchCover(UUID.generate(), () => {}))
        ]
        await vi.advanceTimersByTimeAsync(WCLAP_DISCOVERY_TIMEOUT_MS * 10)
        expect(requests.map(({state}) => state)).toStrictEqual(["pending", "pending", "pending"])
        provider.terminate()
    })
})
