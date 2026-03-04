import {describe, expect, it} from "vitest"
import {CollabService, CollabState} from "./CollabService"

globalThis.RTCPeerConnection = class MockRTCPeerConnection {
    close() {}
} as any

describe("CollabService", () => {
    it("starts in disconnected state", () => {
        const service = new CollabService({endpoint: "wss://localhost:3000"})
        expect(service.state).toBe(CollabState.Disconnected)
    })
    it("exposes room service", () => {
        const service = new CollabService({endpoint: "wss://localhost:3000"})
        expect(service.room).toBeDefined()
    })
    it("exposes presence service", () => {
        const service = new CollabService({endpoint: "wss://localhost:3000"})
        expect(service.presence).toBeDefined()
    })
    it("exposes asset transport", () => {
        const service = new CollabService({endpoint: "wss://localhost:3000"})
        expect(service.assets).toBeDefined()
    })
    it("exposes peer manager", () => {
        const service = new CollabService({endpoint: "wss://localhost:3000"})
        expect(service.peerManager).toBeDefined()
    })
    it("cleans up on terminate", () => {
        const service = new CollabService({endpoint: "wss://localhost:3000"})
        service.terminate()
        expect(service.state).toBe(CollabState.Disconnected)
    })
})
