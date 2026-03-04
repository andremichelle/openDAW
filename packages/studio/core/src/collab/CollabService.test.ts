import {describe, expect, it} from "vitest"
import {CollabService, CollabState} from "./CollabService"

globalThis.RTCPeerConnection = class MockRTCPeerConnection {
    close() {}
} as any

describe("CollabService", () => {
    const config = {endpoint: "wss://localhost:3000"}

    it("starts in disconnected state", () => {
        const service = new CollabService(config)
        expect(service.state).toBe(CollabState.Disconnected)
    })
    it("exposes room service", () => {
        const service = new CollabService(config)
        expect(service.room).toBeDefined()
    })
    it("exposes presence service", () => {
        const service = new CollabService(config)
        expect(service.presence).toBeDefined()
    })
    it("exposes asset transport", () => {
        const service = new CollabService(config)
        expect(service.assets).toBeDefined()
    })
    it("exposes peer manager", () => {
        const service = new CollabService(config)
        expect(service.peerManager).toBeDefined()
    })
    it("exposes stdb connection", () => {
        const service = new CollabService(config)
        expect(service.connection).toBeDefined()
    })
    it("transitions to connecting on createRoom", () => {
        const service = new CollabService(config)
        service.createRoom()
        expect(service.state).toBe(CollabState.Connecting)
    })
    it("transitions to connecting on joinRoom", () => {
        const service = new CollabService(config)
        service.joinRoom("abc123")
        expect(service.state).toBe(CollabState.Connecting)
    })
    it("transitions to disconnected on leaveRoom", () => {
        const service = new CollabService(config)
        service.createRoom()
        service.leaveRoom()
        expect(service.state).toBe(CollabState.Disconnected)
    })
    it("stores roomId on joinRoom", () => {
        const service = new CollabService(config)
        service.joinRoom("abc123")
        expect(service.roomId).toBe("abc123")
    })
    it("generates roomId on createRoom", () => {
        const service = new CollabService(config)
        service.createRoom()
        expect(service.roomId).toBeDefined()
        expect(service.roomId!.length).toBeGreaterThan(0)
    })
    it("clears roomId on leaveRoom", () => {
        const service = new CollabService(config)
        service.joinRoom("abc123")
        service.leaveRoom()
        expect(service.roomId).toBeUndefined()
    })
    it("has 2 asset sources by default (opfs, webrtc)", () => {
        const service = new CollabService(config)
        expect(service.assets.sourceNames).toEqual(["opfs", "webrtc"])
    })
    it("has 3 asset sources when S3 is configured (opfs, s3, webrtc)", () => {
        const service = new CollabService({
            ...config,
            s3: {bucket: "my-bucket", region: "us-east-1", accessKeyId: "key", secretAccessKey: "secret"}
        })
        expect(service.assets.sourceNames).toEqual(["opfs", "s3", "webrtc"])
    })
    it("cleans up on terminate", () => {
        const service = new CollabService(config)
        service.createRoom()
        service.terminate()
        expect(service.state).toBe(CollabState.Disconnected)
        expect(service.roomId).toBeUndefined()
    })
})
