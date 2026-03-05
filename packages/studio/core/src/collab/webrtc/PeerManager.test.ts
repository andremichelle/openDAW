import {afterAll, beforeAll, describe, expect, it, vi} from "vitest"
import {PeerManager} from "./PeerManager"

const OriginalRTCPeerConnection = globalThis.RTCPeerConnection

beforeAll(() => {
    globalThis.RTCPeerConnection = class MockRTCPeerConnection {
        close() {}
    } as any
})

afterAll(() => {
    globalThis.RTCPeerConnection = OriginalRTCPeerConnection
})

describe("PeerManager", () => {
    it("tracks connected peer IDs", () => {
        const manager = new PeerManager()
        expect(manager.peerIds).toEqual([])
    })
    it("emits onPeerConnected when a peer connects", () => {
        const manager = new PeerManager()
        const spy = vi.fn()
        manager.onPeerConnected.subscribe(spy)
        manager.addPeer("peer-1")
        expect(spy).toHaveBeenCalledWith("peer-1")
    })
    it("emits onPeerDisconnected when a peer disconnects", () => {
        const manager = new PeerManager()
        const spy = vi.fn()
        manager.onPeerDisconnected.subscribe(spy)
        manager.addPeer("peer-1")
        manager.removePeer("peer-1")
        expect(spy).toHaveBeenCalledWith("peer-1")
    })
    it("does not add duplicate peers", () => {
        const manager = new PeerManager()
        const spy = vi.fn()
        manager.onPeerConnected.subscribe(spy)
        manager.addPeer("peer-1")
        manager.addPeer("peer-1")
        expect(spy).toHaveBeenCalledTimes(1)
        expect(manager.peerIds).toEqual(["peer-1"])
    })
    it("setDataChannel/getDataChannel round-trip", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        const mockChannel = {close: vi.fn()} as any
        manager.setDataChannel("peer-1", mockChannel)
        expect(manager.getDataChannel("peer-1")).toBe(mockChannel)
    })
    it("getDataChannel returns undefined for unknown peer", () => {
        const manager = new PeerManager()
        expect(manager.getDataChannel("unknown")).toBeUndefined()
    })
    it("getConnection returns undefined for unknown peer", () => {
        const manager = new PeerManager()
        expect(manager.getConnection("unknown")).toBeUndefined()
    })
    it("getConnection returns RTCPeerConnection for known peer", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        const conn = manager.getConnection("peer-1")
        expect(conn).toBeDefined()
    })
    it("removePeer cleans up connection (calls close())", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        const conn = manager.getConnection("peer-1")!
        const closeSpy = vi.spyOn(conn, "close")
        manager.removePeer("peer-1")
        expect(closeSpy).toHaveBeenCalled()
        expect(manager.peerIds).toEqual([])
    })
    it("removePeer on non-existent is no-op", () => {
        const manager = new PeerManager()
        const spy = vi.fn()
        manager.onPeerDisconnected.subscribe(spy)
        manager.removePeer("ghost")
        expect(spy).not.toHaveBeenCalled()
    })
    it("terminate closes all data channels", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        manager.addPeer("peer-2")
        const ch1 = {close: vi.fn()} as any
        const ch2 = {close: vi.fn()} as any
        manager.setDataChannel("peer-1", ch1)
        manager.setDataChannel("peer-2", ch2)
        manager.terminate()
        expect(ch1.close).toHaveBeenCalled()
        expect(ch2.close).toHaveBeenCalled()
    })
    it("cleans up all peers on terminate", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        manager.addPeer("peer-2")
        manager.terminate()
        expect(manager.peerIds).toEqual([])
    })
    it("after terminate, peerIds is empty", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        manager.addPeer("peer-2")
        manager.addPeer("peer-3")
        expect(manager.peerIds).toHaveLength(3)
        manager.terminate()
        expect(manager.peerIds).toEqual([])
    })
    it("setDataChannel closes previous channel before replacing", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        const oldChannel = {close: vi.fn()} as any
        const newChannel = {close: vi.fn()} as any
        manager.setDataChannel("peer-1", oldChannel)
        manager.setDataChannel("peer-1", newChannel)
        expect(oldChannel.close).toHaveBeenCalled()
        expect(manager.getDataChannel("peer-1")).toBe(newChannel)
    })
})
