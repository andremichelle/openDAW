import {describe, expect, it, vi} from "vitest"
import {CollabService, CollabState} from "./CollabService"
import {SignalingService} from "./webrtc/SignalingService"
import {PeerManager} from "./webrtc/PeerManager"
import {AssetTransportChain, AssetSource} from "./assets/AssetTransport"
import {SignalMessage} from "./webrtc/types"

globalThis.RTCPeerConnection = class MockRTCPeerConnection {
    close() {}
} as any

describe("Collaboration Integration", () => {
    const config = {endpoint: "wss://localhost:3000"}

    it("host creates room, guest joins, both see presence, guest leaves", () => {
        const host = new CollabService(config)
        const guest = new CollabService(config)
        host.createRoom()
        const roomId = host.roomId!
        host.connection.simulateConnected("host-id", "host-token")
        expect(host.state).toBe(CollabState.Connected)
        guest.joinRoom(roomId)
        guest.connection.simulateConnected("guest-id", "guest-token")
        expect(guest.state).toBe(CollabState.Connected)
        expect(guest.roomId).toBe(roomId)
        host.presence.updatePresence({
            identity: "guest-id", displayName: "Guest", color: "#0F0",
            cursorX: 10, cursorY: 20, cursorTarget: "track-1",
        })
        guest.presence.updatePresence({
            identity: "host-id", displayName: "Host", color: "#F00",
            cursorX: 30, cursorY: 40, cursorTarget: "track-2",
        })
        expect(host.presence.participants).toHaveLength(1)
        expect(guest.presence.participants).toHaveLength(1)
        guest.leaveRoom()
        expect(guest.state).toBe(CollabState.Disconnected)
        expect(guest.roomId).toBeUndefined()
        expect(guest.presence.participants).toHaveLength(0)
        host.terminate()
        guest.terminate()
    })
    it("host creates room, connection fails, state returns to disconnected", () => {
        const service = new CollabService(config)
        const states: Array<CollabState> = []
        service.onChange.subscribe(state => states.push(state))
        service.createRoom()
        expect(service.state).toBe(CollabState.Connecting)
        service.connection.disconnect()
        expect(service.state).toBe(CollabState.Disconnected)
        expect(service.roomId).toBeUndefined()
        expect(states).toEqual([CollabState.Connecting, CollabState.Disconnected])
        service.terminate()
    })
    it("signaling flow: host and guest exchange offer/answer, become peers", () => {
        const hostPeers = new PeerManager()
        const guestPeers = new PeerManager()
        const hostSignaling = new SignalingService("host-id", hostPeers)
        const guestSignaling = new SignalingService("guest-id", guestPeers)
        const hostOutgoing: Array<SignalMessage> = []
        const guestOutgoing: Array<SignalMessage> = []
        hostSignaling.onOutgoingSignal.subscribe(signal => hostOutgoing.push(signal))
        guestSignaling.onOutgoingSignal.subscribe(signal => guestOutgoing.push(signal))
        hostSignaling.sendOffer("guest-id", '{"sdp":"host-offer"}')
        guestSignaling.handleIncomingSignal(hostOutgoing[0])
        expect(guestPeers.peerIds).toContain("host-id")
        expect(guestOutgoing).toHaveLength(1)
        expect(guestOutgoing[0].signalType).toBe("answer")
        hostSignaling.handleIncomingSignal(guestOutgoing[0])
        expect(hostPeers.peerIds).toContain("guest-id")
        hostSignaling.terminate()
        guestSignaling.terminate()
        hostPeers.terminate()
        guestPeers.terminate()
    })
    it("publish asset to chain, resolve from different source", async () => {
        const store = new Map<string, ArrayBuffer>()
        const source1: AssetSource = {
            name: "memory-1",
            resolve: vi.fn(async (assetId: string) => store.get(assetId)),
            publish: vi.fn(async (assetId: string, data: ArrayBuffer) => {store.set(assetId, data)}),
        }
        const source2: AssetSource = {
            name: "memory-2",
            resolve: vi.fn(async (assetId: string) => store.get(assetId)),
            publish: vi.fn(async (assetId: string, data: ArrayBuffer) => {store.set(assetId, data)}),
        }
        const chain = new AssetTransportChain([source1, source2])
        const data = new Uint8Array([10, 20, 30]).buffer
        const meta = {assetId: "shared-asset", name: "audio.wav", sizeBytes: 3, mimeType: "audio/wav"}
        await chain.publish("shared-asset", data, meta)
        const resolved = await chain.resolve("shared-asset")
        expect(resolved).toBeDefined()
        expect(new Uint8Array(resolved!)).toEqual(new Uint8Array([10, 20, 30]))
    })
    it("leave one room and join another resets state", () => {
        const service = new CollabService(config)
        const states: Array<CollabState> = []
        service.onChange.subscribe(state => states.push(state))
        service.createRoom()
        const firstRoom = service.roomId
        service.connection.simulateConnected("my-id", "my-token")
        service.presence.updatePresence({
            identity: "peer-1", displayName: "Peer", color: "#0FF",
            cursorX: 0, cursorY: 0, cursorTarget: "",
        })
        expect(service.presence.participants).toHaveLength(1)
        service.leaveRoom()
        expect(service.presence.participants).toHaveLength(0)
        expect(service.roomId).toBeUndefined()
        service.joinRoom("second-room")
        expect(service.roomId).toBe("second-room")
        expect(service.state).toBe(CollabState.Connecting)
        expect(service.roomId).not.toBe(firstRoom)
        service.terminate()
    })
})
