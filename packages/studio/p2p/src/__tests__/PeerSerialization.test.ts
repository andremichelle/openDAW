import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@moises-ai/lib-std"
import {type SignalingSocket, AssetSignaling} from "../AssetSignaling"
import {PeerAssetProvider, STALL_TIMEOUT_MS} from "../PeerAssetProvider"

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

const getRtcOffers = (socket: MockSocket): Array<Record<string, unknown>> =>
    getPublishData(socket).filter(data => data.type === "rtc-offer")

const sendInventory = (socket: MockSocket, fromPeer: string, targetPeer: string, have: ReadonlyArray<string>): void => {
    socket.simulateMessage(publishEnvelope("assets:room", {
        type: "asset-inventory",
        peerId: fromPeer,
        targetPeerId: targetPeer,
        have
    }))
}

describe("Peer Transfer Serialization", () => {
    beforeEach(() => {vi.useFakeTimers()})
    afterEach(() => {vi.useRealTimers()})

    it("only creates one WebRTC connection per peer at a time", async () => {
        const socket = createMockSocket()
        const signaling = new AssetSignaling(socket, "assets:room")
        const provider = new PeerAssetProvider(signaling, "peer-A")
        const uuid1 = UUID.generate()
        const uuid2 = UUID.generate()
        const uuid1Str = UUID.toString(uuid1)
        const uuid2Str = UUID.toString(uuid2)
        provider.fetchSample(uuid1, () => {}).catch(() => {})
        provider.fetchSample(uuid2, () => {}).catch(() => {})
        sendInventory(socket, "peer-B", "peer-A", [uuid1Str])
        await vi.advanceTimersByTimeAsync(0)
        const offersAfterFirst = getRtcOffers(socket).length
        expect(offersAfterFirst).toBe(1)
        sendInventory(socket, "peer-B", "peer-A", [uuid2Str])
        await vi.advanceTimersByTimeAsync(0)
        const offersAfterSecond = getRtcOffers(socket).length
        expect(offersAfterSecond).toBe(1)
        provider.terminate()
    })

    it("queues second transfer and starts it after first completes or fails", async () => {
        const socket = createMockSocket()
        const signaling = new AssetSignaling(socket, "assets:room")
        const provider = new PeerAssetProvider(signaling, "peer-A")
        const uuid1 = UUID.generate()
        const uuid2 = UUID.generate()
        const uuid1Str = UUID.toString(uuid1)
        const uuid2Str = UUID.toString(uuid2)
        provider.fetchSample(uuid1, () => {}).catch(() => {})
        provider.fetchSample(uuid2, () => {}).catch(() => {})
        sendInventory(socket, "peer-B", "peer-A", [uuid1Str])
        sendInventory(socket, "peer-B", "peer-A", [uuid2Str])
        await vi.advanceTimersByTimeAsync(0)
        const offersBeforeTimeout = getRtcOffers(socket).length
        expect(offersBeforeTimeout).toBe(1)
        await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 100)
        await vi.advanceTimersByTimeAsync(0)
        const offersAfterFirstFail = getRtcOffers(socket).length
        expect(offersAfterFirstFail).toBeGreaterThan(1)
        provider.terminate()
    })

    it("allows concurrent transfers to different peers", async () => {
        const socket = createMockSocket()
        const signaling = new AssetSignaling(socket, "assets:room")
        const provider = new PeerAssetProvider(signaling, "peer-A")
        const uuid1 = UUID.generate()
        const uuid2 = UUID.generate()
        const uuid1Str = UUID.toString(uuid1)
        const uuid2Str = UUID.toString(uuid2)
        provider.fetchSample(uuid1, () => {}).catch(() => {})
        provider.fetchSample(uuid2, () => {}).catch(() => {})
        sendInventory(socket, "peer-B", "peer-A", [uuid1Str])
        await vi.advanceTimersByTimeAsync(0)
        sendInventory(socket, "peer-C", "peer-A", [uuid2Str])
        await vi.advanceTimersByTimeAsync(0)
        const offers = getRtcOffers(socket)
        expect(offers.length).toBe(2)
        const targetPeers = offers.map(offer => offer.targetPeerId)
        expect(targetPeers).toContain("peer-B")
        expect(targetPeers).toContain("peer-C")
        provider.terminate()
    })
})
