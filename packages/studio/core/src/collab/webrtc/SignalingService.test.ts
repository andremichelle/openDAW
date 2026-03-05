import {afterAll, beforeAll, describe, expect, it, vi} from "vitest"
import {SignalingService} from "./SignalingService"
import {PeerManager} from "./PeerManager"
import {SignalMessage} from "./types"

const OriginalRTCPeerConnection = globalThis.RTCPeerConnection

beforeAll(() => {
    globalThis.RTCPeerConnection = class MockRTCPeerConnection {
        close() {}
        setRemoteDescription() {return Promise.resolve()}
        setLocalDescription() {return Promise.resolve()}
        createAnswer() {return Promise.resolve({type: "answer", sdp: "mock-sdp"})}
        addIceCandidate() {return Promise.resolve()}
    } as any
})

afterAll(() => {
    globalThis.RTCPeerConnection = OriginalRTCPeerConnection
})

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
    it("sendIceCandidate emits correct signal type", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        const signals: Array<SignalMessage> = []
        service.onOutgoingSignal.subscribe(signal => signals.push(signal))
        service.sendIceCandidate("remote-id", '{"candidate":"test"}')
        expect(signals).toHaveLength(1)
        expect(signals[0].signalType).toBe("ice")
        expect(signals[0].fromIdentity).toBe("local-id")
        expect(signals[0].toIdentity).toBe("remote-id")
        expect(signals[0].payload).toBe('{"candidate":"test"}')
    })
    it("should handle incoming offer by adding peer", async () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        await service.handleIncomingSignal({
            fromIdentity: "remote-id",
            toIdentity: "local-id",
            signalType: "offer",
            payload: '{"sdp":"test"}',
        })
        expect(peerManager.peerIds).toContain("remote-id")
    })
    it("incoming answer adds peer without auto-reply", async () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        const signals: Array<SignalMessage> = []
        service.onOutgoingSignal.subscribe(signal => signals.push(signal))
        peerManager.addPeer("remote-id")
        await service.handleIncomingSignal({
            fromIdentity: "remote-id",
            toIdentity: "local-id",
            signalType: "answer",
            payload: '{"sdp":"answer-sdp"}',
        })
        expect(peerManager.peerIds).toContain("remote-id")
        expect(signals).toHaveLength(0)
    })
    it("two-way handshake: A sends offer, B auto-answers", async () => {
        const peerManagerA = new PeerManager()
        const peerManagerB = new PeerManager()
        const serviceA = new SignalingService("A", peerManagerA)
        const serviceB = new SignalingService("B", peerManagerB)
        const signalsFromA: Array<SignalMessage> = []
        const signalsFromB: Array<SignalMessage> = []
        serviceA.onOutgoingSignal.subscribe(signal => signalsFromA.push(signal))
        serviceB.onOutgoingSignal.subscribe(signal => signalsFromB.push(signal))
        serviceA.sendOffer("B", '{"sdp":"offer-from-A"}')
        await serviceB.handleIncomingSignal(signalsFromA[0])
        expect(peerManagerB.peerIds).toContain("A")
        expect(signalsFromB).toHaveLength(1)
        expect(signalsFromB[0].signalType).toBe("answer")
        await serviceA.handleIncomingSignal(signalsFromB[0])
        expect(peerManagerA.peerIds).toContain("B")
    })
    it("multiple peers exchange signals independently", async () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local", peerManager)
        await service.handleIncomingSignal({
            fromIdentity: "peer-1", toIdentity: "local", signalType: "offer", payload: "{}",
        })
        await service.handleIncomingSignal({
            fromIdentity: "peer-2", toIdentity: "local", signalType: "offer", payload: "{}",
        })
        expect(peerManager.peerIds).toContain("peer-1")
        expect(peerManager.peerIds).toContain("peer-2")
        expect(peerManager.peerIds).toHaveLength(2)
    })
    it("should ignore signals not addressed to local identity", async () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        await service.handleIncomingSignal({
            fromIdentity: "remote-id",
            toIdentity: "other-id",
            signalType: "offer",
            payload: '{"sdp":"test"}',
        })
        expect(peerManager.peerIds).toHaveLength(0)
    })
    it("signals from self are ignored (toIdentity mismatch)", async () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        await service.handleIncomingSignal({
            fromIdentity: "local-id",
            toIdentity: "someone-else",
            signalType: "offer",
            payload: "{}",
        })
        expect(peerManager.peerIds).toHaveLength(0)
    })
    it("should emit answer signal on incoming offer", async () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        const signals: Array<SignalMessage> = []
        service.onOutgoingSignal.subscribe(signal => signals.push(signal))
        await service.handleIncomingSignal({
            fromIdentity: "remote-id",
            toIdentity: "local-id",
            signalType: "offer",
            payload: '{"sdp":"test"}',
        })
        expect(signals).toHaveLength(1)
        expect(signals[0].signalType).toBe("answer")
        expect(signals[0].toIdentity).toBe("remote-id")
    })
    it("terminate prevents existing subscribers from receiving further signals", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        const spy = vi.fn()
        service.onOutgoingSignal.subscribe(spy)
        service.sendOffer("remote-id", '{"sdp":"before"}')
        expect(spy).toHaveBeenCalledTimes(1)
        service.terminate()
        service.sendOffer("remote-id", '{"sdp":"after"}')
        expect(spy).toHaveBeenCalledTimes(1)
    })
    it("should clean up on terminate", () => {
        const peerManager = new PeerManager()
        const service = new SignalingService("local-id", peerManager)
        service.terminate()
        expect(service.localIdentity).toBe("local-id")
    })
})
