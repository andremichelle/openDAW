import {describe, expect, it, vi, beforeEach} from "vitest"
import {StdbConnection, StdbConnectionState} from "./StdbConnection"

describe("StdbConnection", () => {
    let connection: StdbConnection

    beforeEach(() => {
        connection = new StdbConnection({
            endpoint: "ws://localhost:3000",
            databaseName: "test-db",
        })
    })

    it("should start in disconnected state", () => {
        expect(connection.state).toBe(StdbConnectionState.Disconnected)
    })
    it("should transition to connecting on connect()", () => {
        connection.connect()
        expect(connection.state).toBe(StdbConnectionState.Connecting)
    })
    it("connect() is no-op when already connecting", () => {
        const spy = vi.fn()
        connection.connect()
        connection.onChange.subscribe(spy)
        connection.connect()
        expect(spy).not.toHaveBeenCalled()
        expect(connection.state).toBe(StdbConnectionState.Connecting)
    })
    it("connect() is no-op when already connected", () => {
        connection.connect()
        connection.simulateConnected("id-1", "token-1")
        const spy = vi.fn()
        connection.onChange.subscribe(spy)
        connection.connect()
        expect(spy).not.toHaveBeenCalled()
        expect(connection.state).toBe(StdbConnectionState.Connected)
    })
    it("should transition to disconnected on disconnect()", () => {
        connection.connect()
        connection.disconnect()
        expect(connection.state).toBe(StdbConnectionState.Disconnected)
    })
    it("disconnect() is no-op when already disconnected", () => {
        const spy = vi.fn()
        connection.onChange.subscribe(spy)
        connection.disconnect()
        expect(spy).not.toHaveBeenCalled()
    })
    it("disconnect() clears identity", () => {
        connection.connect()
        connection.simulateConnected("test-id", "test-token")
        expect(connection.identity).toBe("test-id")
        connection.disconnect()
        expect(connection.identity).toBeUndefined()
    })
    it("connect→disconnect→connect cycle works", () => {
        const states: Array<StdbConnectionState> = []
        connection.onChange.subscribe(state => states.push(state))
        connection.connect()
        connection.disconnect()
        connection.connect()
        expect(states).toEqual([
            StdbConnectionState.Connecting,
            StdbConnectionState.Disconnected,
            StdbConnectionState.Connecting,
        ])
    })
    it("should notify state changes via onChange", () => {
        const states: Array<StdbConnectionState> = []
        connection.onChange.subscribe(state => states.push(state))
        connection.connect()
        connection.disconnect()
        expect(states).toEqual([StdbConnectionState.Connecting, StdbConnectionState.Disconnected])
    })
    it("simulateConnected notifies Connected state", () => {
        const states: Array<StdbConnectionState> = []
        connection.onChange.subscribe(state => states.push(state))
        connection.connect()
        connection.simulateConnected("test-identity", "test-token")
        expect(states).toEqual([StdbConnectionState.Connecting, StdbConnectionState.Connected])
    })
    it("should store identity after simulated connection", () => {
        expect(connection.identity).toBeUndefined()
        connection.connect()
        connection.simulateConnected("test-identity", "test-token")
        expect(connection.state).toBe(StdbConnectionState.Connected)
        expect(connection.identity).toBe("test-identity")
        expect(connection.token).toBe("test-token")
    })
    it("multiple subscribers all receive notifications", () => {
        const spy1 = vi.fn()
        const spy2 = vi.fn()
        const spy3 = vi.fn()
        connection.onChange.subscribe(spy1)
        connection.onChange.subscribe(spy2)
        connection.onChange.subscribe(spy3)
        connection.connect()
        expect(spy1).toHaveBeenCalledWith(StdbConnectionState.Connecting)
        expect(spy2).toHaveBeenCalledWith(StdbConnectionState.Connecting)
        expect(spy3).toHaveBeenCalledWith(StdbConnectionState.Connecting)
    })
    it("should clean up on terminate", () => {
        connection.connect()
        connection.simulateConnected("test-identity", "test-token")
        connection.terminate()
        expect(connection.state).toBe(StdbConnectionState.Disconnected)
        expect(connection.identity).toBeUndefined()
    })
    it("terminate clears token", () => {
        connection.connect()
        connection.simulateConnected("id", "secret-token")
        connection.terminate()
        expect(connection.token).toBeUndefined()
    })
    it("terminate is idempotent", () => {
        connection.connect()
        connection.simulateConnected("id", "token")
        connection.terminate()
        connection.terminate()
        expect(connection.state).toBe(StdbConnectionState.Disconnected)
    })
    it("preserves config token from constructor", () => {
        const conn = new StdbConnection({
            endpoint: "ws://localhost",
            databaseName: "db",
            token: "initial-token",
        })
        expect(conn.token).toBe("initial-token")
    })
})
