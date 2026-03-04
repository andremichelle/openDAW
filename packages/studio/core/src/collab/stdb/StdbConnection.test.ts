import {describe, expect, it, vi, beforeEach} from "vitest"
import {StdbConnection, StdbConnectionState} from "./StdbConnection"

describe("StdbConnection", () => {
    let connection: StdbConnection

    beforeEach(() => {
        connection = new StdbConnection({
            endpoint: "ws://localhost:3000",
            databaseName: "test-db"
        })
    })

    it("should start in disconnected state", () => {
        expect(connection.state).toBe(StdbConnectionState.Disconnected)
    })

    it("should transition to connecting on connect()", () => {
        connection.connect()
        expect(connection.state).toBe(StdbConnectionState.Connecting)
    })

    it("should transition to disconnected on disconnect()", () => {
        connection.connect()
        connection.disconnect()
        expect(connection.state).toBe(StdbConnectionState.Disconnected)
    })

    it("should notify state changes via onChange", () => {
        const states: Array<StdbConnectionState> = []
        connection.onChange.subscribe(state => states.push(state))
        connection.connect()
        connection.disconnect()
        expect(states).toEqual([StdbConnectionState.Connecting, StdbConnectionState.Disconnected])
    })

    it("should store identity after simulated connection", () => {
        expect(connection.identity).toBeUndefined()
        connection.connect()
        connection.simulateConnected("test-identity", "test-token")
        expect(connection.state).toBe(StdbConnectionState.Connected)
        expect(connection.identity).toBe("test-identity")
        expect(connection.token).toBe("test-token")
    })

    it("should clean up on terminate", () => {
        connection.connect()
        connection.simulateConnected("test-identity", "test-token")
        connection.terminate()
        expect(connection.state).toBe(StdbConnectionState.Disconnected)
        expect(connection.identity).toBeUndefined()
    })
})
