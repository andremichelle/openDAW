import {describe, expect, it, vi} from "vitest"
import {SignalingService} from "./SignalingService"
import {PeerManager} from "./PeerManager"
import {SignalMessage} from "./types"

globalThis.RTCPeerConnection = class MockRTCPeerConnection {
    close() {}
} as any

describe("SignalingService", () => {
    it("should queue outgoing signals", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        const signals: Array<SignalMessage> = []
        service.onOutgoingSignal.subscribe(signal => signals.push(signal))
        service.sendOffer("remote-id", '{"sdp":"test"}')
        expect(signals).toHaveLength(1)
        expect(signals[0].signalType).toBe("offer")
        expect(signals[0].fromIdentity).toBe("local-id")
        expect(signals[0].toIdentity).toBe("remote-id")
    })

    it("should handle incoming offer by adding peer", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        service.handleIncomingSignal({
            fromIdentity: "remote-id",
            toIdentity: "local-id",
            signalType: "offer",
            payload: '{"sdp":"test"}'
        })
        expect(peerManager.peerIds).toContain("remote-id")
    })

    it("should ignore signals not addressed to local identity", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        service.handleIncomingSignal({
            fromIdentity: "remote-id",
            toIdentity: "other-id",
            signalType: "offer",
            payload: '{"sdp":"test"}'
        })
        expect(peerManager.peerIds).toHaveLength(0)
    })

    it("should emit answer signal on incoming offer", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        const signals: Array<SignalMessage> = []
        service.onOutgoingSignal.subscribe(signal => signals.push(signal))
        service.handleIncomingSignal({
            fromIdentity: "remote-id",
            toIdentity: "local-id",
            signalType: "offer",
            payload: '{"sdp":"test"}'
        })
        expect(signals).toHaveLength(1)
        expect(signals[0].signalType).toBe("answer")
        expect(signals[0].toIdentity).toBe("remote-id")
    })

    it("should clean up on terminate", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        service.terminate()
        expect(service.localIdentity).toBe("local-id")
    })
})
