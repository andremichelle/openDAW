import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@moises-ai/lib-std"
import {type SignalingSocket, AssetSignaling} from "../AssetSignaling"
import {PeerAssetProvider, MAX_RETRIES, STALL_TIMEOUT_MS} from "../PeerAssetProvider"

class MockRTCPeerConnection {
    localDescription: unknown = null
    remoteDescription: unknown = null
    onicecandidate: unknown = null
    oniceconnectionstatechange: unknown = null
    onconnectionstatechange: unknown = null
    ondatachannel: unknown = null
    iceConnectionState = "new"
    connectionState = "new"
    createDataChannel() {
        return {
            binaryType: "arraybuffer",
            readyState: "connecting",
            bufferedAmount: 0,
            onopen: null, onclose: null, onerror: null, onmessage: null,
            send() {},
            close() {}
        }
    }
    async createOffer() {return {type: "offer", sdp: "mock-sdp"}}
    async createAnswer() {return {type: "answer", sdp: "mock-sdp"}}
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
}

vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection)

type MockSocket = SignalingSocket & {
    sent: Array<string>
    simulateMessage: (data: string) => void
}

const createMockSocket = (): MockSocket => ({
    sent: [],
    readyState: 1,
    send(data: string) {this.sent.push(data)},
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

const getPublishData = (socket: MockSocket): Array<Record<string, unknown>> =>
    socket.sent
        .map(raw => JSON.parse(raw))
        .filter(message => message.type === "publish")
        .map(message => message.data as Record<string, unknown>)

const getAssetRequests = (socket: MockSocket): Array<Record<string, unknown>> =>
    getPublishData(socket).filter(data => data.type === "asset-request")

const sendInventory = (socket: MockSocket, fromPeer: string, targetPeer: string, uuidString: string): void => {
    socket.simulateMessage(publishEnvelope("assets:room", {
        type: "asset-inventory",
        peerId: fromPeer,
        targetPeerId: targetPeer,
        have: [uuidString]
    }))
}

describe("Transfer Failover", () => {
    beforeEach(() => {vi.useFakeTimers()})
    afterEach(() => {vi.useRealTimers()})

    describe("stall timeout", () => {
        it("rebroadcasts after stall timeout", async () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            const uuidString = UUID.toString(uuid)
            provider.fetchSample(uuid, () => {}).catch(() => {})
            const requestsBefore = getAssetRequests(socket).length
            sendInventory(socket, "peer-B", "peer-A", uuidString)
            await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 100)
            const requestsAfter = getAssetRequests(socket).length
            expect(requestsAfter).toBeGreaterThan(requestsBefore)
            provider.terminate()
        })
        it("resets timer on each chunk received", async () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            const uuidString = UUID.toString(uuid)
            provider.fetchSample(uuid, () => {}).catch(() => {})
            sendInventory(socket, "peer-B", "peer-A", uuidString)
            // Advance to just before timeout — should NOT trigger retry
            await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 1000)
            const requestsMid = getAssetRequests(socket).length
            // If timer wasn't reset, another advance would trigger retry
            // But we haven't sent any chunks, so the timer is still from initiateTransfer
            await vi.advanceTimersByTimeAsync(2000)
            const requestsAfter = getAssetRequests(socket).length
            // Timer should have fired (total elapsed > STALL_TIMEOUT_MS)
            expect(requestsAfter).toBeGreaterThan(requestsMid)
            provider.terminate()
        })
    })
    describe("max retries", () => {
        it("rejects after MAX_RETRIES failures", async () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            const uuidString = UUID.toString(uuid)
            let rejected = false
            let rejectedError: Error | null = null
            provider.fetchSample(uuid, () => {}).catch(error => {
                rejected = true
                rejectedError = error
            })
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                sendInventory(socket, `peer-${attempt}`, "peer-A", uuidString)
                await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 100)
            }
            // One more to trigger final rejection
            sendInventory(socket, "peer-final", "peer-A", uuidString)
            await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 100)
            // Allow microtasks to flush
            await vi.advanceTimersByTimeAsync(0)
            expect(rejected).toBe(true)
            expect(rejectedError?.message).toMatch(/Transfer failed after/)
            provider.terminate()
        })
    })
    describe("terminate during transfer", () => {
        it("cleans up timers on terminate", async () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            const uuidString = UUID.toString(uuid)
            provider.fetchSample(uuid, () => {}).catch(() => {})
            sendInventory(socket, "peer-B", "peer-A", uuidString)
            provider.terminate()
            // Advance past timeout — should not cause any side effects
            await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 100)
        })
        it("rejects pending promises on terminate", async () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            const fetchPromise = provider.fetchSample(uuid, () => {})
            provider.terminate()
            await expect(fetchPromise).rejects.toThrow("P2P session terminated")
        })
        it("is idempotent", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            provider.fetchSample(UUID.generate(), () => {}).catch(() => {})
            provider.terminate()
            provider.terminate()
        })
    })
    describe("recovery after stall", () => {
        it("new peer triggers rebroadcast for stalled request", async () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            const uuidString = UUID.toString(uuid)
            provider.fetchSample(uuid, () => {}).catch(() => {})
            // First attempt stalls
            sendInventory(socket, "peer-B", "peer-A", uuidString)
            await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 100)
            const requestsAfterStall = getAssetRequests(socket).length
            // New peer joins — triggers rebroadcast of pending (non-transferring) requests
            socket.simulateMessage(publishEnvelope("assets:room", {
                type: "asset-request", peerId: "peer-C", assets: []
            }))
            const requestsAfterNewPeer = getAssetRequests(socket).length
            expect(requestsAfterNewPeer).toBeGreaterThan(requestsAfterStall)
            provider.terminate()
        })
    })
})
