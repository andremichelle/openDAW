import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {type SignalingMessage, type SignalingSocket, AssetSignaling} from "../AssetSignaling"
import {PeerAssetProvider} from "../PeerAssetProvider"

type MockSocket = SignalingSocket & {
    sent: Array<string>
    simulateMessage: (data: string) => void
    simulateOpen: () => void
}

const createMockSocket = (connected: boolean = true): MockSocket => ({
    sent: [],
    readyState: connected ? 1 : 0,
    send(data: string) {this.sent.push(data)},
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    simulateMessage(data: string) {
        if (this.onmessage !== null) {this.onmessage({data})}
    },
    simulateOpen() {
        this.readyState = 1
        if (this.onopen !== null) {this.onopen({})}
    }
})

const publishEnvelope = (topic: string, message: Record<string, unknown>): string =>
    JSON.stringify({type: "publish", topic, data: message})

const getPublishMessages = (socket: MockSocket): Array<Record<string, unknown>> =>
    socket.sent.map(raw => JSON.parse(raw)).filter(message => message.type === "publish")

const getPublishData = (socket: MockSocket): Array<Record<string, unknown>> =>
    getPublishMessages(socket).map(message => message.data as Record<string, unknown>)

describe("Peer Discovery", () => {
    describe("requester joins before provider", () => {
        it("rebroadcasts pending requests when a new peer appears", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "local-peer")
            const uuid = UUID.generate()
            provider.fetchSample(uuid, () => {}).catch(() => {})
            const publishesBefore = getPublishMessages(socket).length
            socket.simulateMessage(publishEnvelope("assets:room", {
                type: "asset-request", peerId: "new-peer", assets: []
            }))
            const publishesAfter = getPublishMessages(socket).length
            expect(publishesAfter).toBe(publishesBefore + 1)
            provider.terminate()
        })
        it("does not rebroadcast for already known peers", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "local-peer")
            const uuid = UUID.generate()
            provider.fetchSample(uuid, () => {}).catch(() => {})
            socket.simulateMessage(publishEnvelope("assets:room", {
                type: "asset-request", peerId: "peer-B", assets: []
            }))
            const publishesAfterFirst = getPublishMessages(socket).length
            socket.simulateMessage(publishEnvelope("assets:room", {
                type: "asset-request", peerId: "peer-B", assets: []
            }))
            const publishesAfterSecond = getPublishMessages(socket).length
            expect(publishesAfterSecond).toBe(publishesAfterFirst)
            provider.terminate()
        })
    })
    describe("targetPeerId filtering (3+ peers)", () => {
        it("ignores inventory meant for a different peer", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            const uuidString = UUID.toString(uuid)
            provider.fetchSample(uuid, () => {}).catch(() => {})
            // Inventory targeting peer-B, not peer-A — should be ignored
            socket.simulateMessage(publishEnvelope("assets:room", {
                type: "asset-inventory",
                peerId: "peer-C",
                targetPeerId: "peer-B",
                have: [uuidString]
            }))
            // No rtc-offer should be sent (no transfer initiated)
            const rtcOffers = getPublishData(socket).filter(data => data.type === "rtc-offer")
            expect(rtcOffers.length).toBe(0)
            provider.terminate()
        })
        it("ignores rtc-answer meant for a different peer", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            provider.fetchSample(uuid, () => {}).catch(() => {})
            // rtc-answer targeting peer-B (not us) — should be silently ignored
            socket.simulateMessage(publishEnvelope("assets:room", {
                type: "rtc-answer",
                peerId: "peer-C",
                targetPeerId: "peer-B",
                sdp: "fake-sdp"
            }))
            // No error — test passes if no exception thrown
            provider.terminate()
        })
        it("ignores rtc-ice-candidate meant for a different peer", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const provider = new PeerAssetProvider(signaling, "peer-A")
            const uuid = UUID.generate()
            provider.fetchSample(uuid, () => {}).catch(() => {})
            // ICE candidate targeting peer-B — should be silently ignored
            socket.simulateMessage(publishEnvelope("assets:room", {
                type: "rtc-ice-candidate",
                peerId: "peer-C",
                targetPeerId: "peer-B",
                candidate: {}
            }))
            provider.terminate()
        })
    })
})
