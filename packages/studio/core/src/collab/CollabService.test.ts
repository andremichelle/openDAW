import {describe, expect, it, vi} from "vitest"
import {CollabService, CollabState} from "./CollabService"
import {StdbConnectionState} from "./stdb/StdbConnection"

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
    it("roomId is undefined after createRoom (server-generated)", () => {
        const service = new CollabService(config)
        service.createRoom()
        expect(service.roomId).toBeUndefined()
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
    it("cleans up on terminate", () => {
        const service = new CollabService(config)
        service.createRoom()
        service.terminate()
        expect(service.state).toBe(CollabState.Disconnected)
        expect(service.roomId).toBeUndefined()
    })
    it("onChange notifies Connecting on createRoom", () => {
        const service = new CollabService(config)
        const states: Array<CollabState> = []
        service.onChange.subscribe(state => states.push(state))
        service.createRoom()
        expect(states).toContain(CollabState.Connecting)
    })
    it("onChange notifies Connected when connection.simulateConnected is called", () => {
        const service = new CollabService(config)
        const states: Array<CollabState> = []
        service.onChange.subscribe(state => states.push(state))
        service.createRoom()
        service.connection.simulateConnected("test-id", "test-token")
        expect(states).toEqual([CollabState.Connecting, CollabState.Connected])
        expect(service.state).toBe(CollabState.Connected)
    })
    it("onChange notifies Disconnected on leaveRoom", () => {
        const service = new CollabService(config)
        const states: Array<CollabState> = []
        service.onChange.subscribe(state => states.push(state))
        service.createRoom()
        service.connection.simulateConnected("test-id", "test-token")
        service.leaveRoom()
        expect(states).toEqual([CollabState.Connecting, CollabState.Connected, CollabState.Disconnected])
    })
    it("unexpected disconnect notifies Disconnected", () => {
        const service = new CollabService(config)
        const states: Array<CollabState> = []
        service.onChange.subscribe(state => states.push(state))
        service.createRoom()
        service.connection.simulateConnected("test-id", "test-token")
        service.connection.disconnect()
        expect(states).toContain(CollabState.Disconnected)
        expect(service.state).toBe(CollabState.Disconnected)
        expect(service.roomId).toBeUndefined()
    })
    it("unexpected disconnect clears presence", () => {
        const service = new CollabService(config)
        service.createRoom()
        service.connection.simulateConnected("test-id", "test-token")
        service.presence.updatePresence({
            identity: "other", displayName: "Bob", color: "#00F",
            cursorX: 0, cursorY: 0, cursorTarget: "",
        })
        expect(service.presence.participants).toHaveLength(1)
        service.connection.disconnect()
        expect(service.presence.participants).toHaveLength(0)
    })
    it("full lifecycle: createRoom→connect→presence→leaveRoom", () => {
        const service = new CollabService(config)
        const states: Array<CollabState> = []
        service.onChange.subscribe(state => states.push(state))
        service.createRoom()
        expect(service.roomId).toBeUndefined()
        service.connection.simulateConnected("host-id", "host-token")
        service.presence.updatePresence({
            identity: "guest-1", displayName: "Guest", color: "#0F0",
            cursorX: 50, cursorY: 50, cursorTarget: "track-1",
        })
        expect(service.presence.participants).toHaveLength(1)
        service.leaveRoom()
        expect(service.state).toBe(CollabState.Disconnected)
        expect(service.roomId).toBeUndefined()
        expect(service.presence.participants).toHaveLength(0)
        expect(states).toEqual([CollabState.Connecting, CollabState.Connected, CollabState.Disconnected])
    })
    it("joinRoom while already connected disconnects first via leaveRoom", () => {
        const service = new CollabService(config)
        service.createRoom()
        service.connection.simulateConnected("id-1", "token-1")
        expect(service.state).toBe(CollabState.Connected)
        service.leaveRoom()
        service.joinRoom("new-room")
        expect(service.state).toBe(CollabState.Connecting)
        expect(service.roomId).toBe("new-room")
    })
    it("leaveRoom when disconnected is safe", () => {
        const service = new CollabService(config)
        const spy = vi.fn()
        service.onChange.subscribe(spy)
        service.leaveRoom()
        expect(spy).toHaveBeenCalledWith(CollabState.Disconnected)
        expect(service.state).toBe(CollabState.Disconnected)
    })
    it("joinRoom with different IDs sets correct roomId each time", () => {
        const service = new CollabService(config)
        service.joinRoom("room-1")
        expect(service.roomId).toBe("room-1")
        service.leaveRoom()
        service.joinRoom("room-2")
        expect(service.roomId).toBe("room-2")
    })
    it("terminate while connecting", () => {
        const service = new CollabService(config)
        service.createRoom()
        expect(service.state).toBe(CollabState.Connecting)
        service.terminate()
        expect(service.state).toBe(CollabState.Disconnected)
        expect(service.roomId).toBeUndefined()
    })
    it("databaseName passes through to connection config", () => {
        const service = new CollabService({...config, databaseName: "my-db"})
        expect(service.connection.config.databaseName).toBe("my-db")
    })
    it("databaseName defaults to 'opendaw'", () => {
        const service = new CollabService(config)
        expect(service.connection.config.databaseName).toBe("opendaw")
    })
})
