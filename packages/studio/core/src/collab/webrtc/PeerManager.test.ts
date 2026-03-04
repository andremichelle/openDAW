globalThis.RTCPeerConnection = class MockRTCPeerConnection {
    close() {}
} as any

import {describe, expect, it, vi} from "vitest"
import {PeerManager} from "./PeerManager"

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
    it("cleans up all peers on terminate", () => {
        const manager = new PeerManager()
        manager.addPeer("peer-1")
        manager.addPeer("peer-2")
        manager.terminate()
        expect(manager.peerIds).toEqual([])
    })
})
