import {describe, expect, it, vi} from "vitest"
import {AssetSignaling, type SignalingSocket} from "../AssetSignaling"

const createMockSocket = (connected: boolean = true): SignalingSocket & { sent: Array<string>, simulateMessage: (data: string) => void, simulateOpen: () => void } => {
    const socket: SignalingSocket & { sent: Array<string>, simulateMessage: (data: string) => void, simulateOpen: () => void } = {
        sent: [],
        readyState: connected ? 1 : 0,
        send(data: string) {this.sent.push(data)},
        close() {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        simulateMessage(data: string) {
            if (this.onmessage !== null) {
                this.onmessage({data})
            }
        },
        simulateOpen() {
            this.readyState = 1
            if (this.onopen !== null) {
                this.onopen({})
            }
        }
    }
    return socket
}

describe("AssetSignaling", () => {
    describe("construction", () => {
        it("subscribes to the topic on creation", () => {
            const socket = createMockSocket()
            new AssetSignaling(socket, "assets:test-room")
            expect(socket.sent.length).toBe(1)
            expect(JSON.parse(socket.sent[0])).toEqual({
                type: "subscribe",
                topics: ["assets:test-room"]
            })
        })
        it("exposes the topic", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:my-room")
            expect(signaling.topic).toBe("assets:my-room")
        })
    })
    describe("publish", () => {
        it("sends message wrapped in publish envelope", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            signaling.publish({type: "asset-request", missing: ["uuid-1", "uuid-2"]})
            expect(socket.sent.length).toBe(2) // subscribe + publish
            expect(JSON.parse(socket.sent[1])).toEqual({
                type: "publish",
                topic: "assets:room",
                data: {type: "asset-request", missing: ["uuid-1", "uuid-2"]}
            })
        })
        it("does not send after terminate", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            signaling.terminate()
            const sentCount = socket.sent.length
            signaling.publish({type: "asset-request", missing: []})
            expect(socket.sent.length).toBe(sentCount)
        })
    })
    describe("receiving messages", () => {
        it("notifies subscribers of messages matching the topic", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const received: Array<unknown> = []
            signaling.subscribe(message => received.push(message))
            socket.simulateMessage(JSON.stringify({
                type: "publish",
                topic: "assets:room",
                data: {type: "asset-inventory", peerId: "abc", have: ["uuid-1"]}
            }))
            expect(received.length).toBe(1)
            expect(received[0]).toEqual({
                type: "asset-inventory",
                peerId: "abc",
                have: ["uuid-1"]
            })
        })
        it("ignores messages for different topics", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room-a")
            const received: Array<unknown> = []
            signaling.subscribe(message => received.push(message))
            socket.simulateMessage(JSON.stringify({
                type: "publish",
                topic: "assets:room-b",
                data: {type: "asset-inventory", peerId: "abc"}
            }))
            expect(received.length).toBe(0)
        })
        it("ignores malformed JSON", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const received: Array<unknown> = []
            signaling.subscribe(message => received.push(message))
            socket.simulateMessage("not valid json{{{")
            expect(received.length).toBe(0)
        })
        it("does not notify after terminate", () => {
            const socket = createMockSocket()
            const signaling = new AssetSignaling(socket, "assets:room")
            const received: Array<unknown> = []
            signaling.subscribe(message => received.push(message))
            signaling.terminate()
            socket.simulateMessage(JSON.stringify({
                type: "publish",
                topic: "assets:room",
                data: {type: "asset-inventory", peerId: "abc"}
            }))
            expect(received.length).toBe(0)
        })
    })
    describe("terminate", () => {
        it("sends unsubscribe and closes socket", () => {
            const socket = createMockSocket()
            const closeSpy = vi.spyOn(socket, "close")
            const signaling = new AssetSignaling(socket, "assets:room")
            signaling.terminate()
            const lastSent = JSON.parse(socket.sent[socket.sent.length - 1])
            expect(lastSent).toEqual({type: "unsubscribe", topics: ["assets:room"]})
            expect(closeSpy).toHaveBeenCalledOnce()
        })
        it("is idempotent", () => {
            const socket = createMockSocket()
            const closeSpy = vi.spyOn(socket, "close")
            const signaling = new AssetSignaling(socket, "assets:room")
            signaling.terminate()
            signaling.terminate()
            expect(closeSpy).toHaveBeenCalledOnce()
        })
        it("is triggered by socket close", () => {
            const socket = createMockSocket()
            const closeSpy = vi.spyOn(socket, "close")
            new AssetSignaling(socket, "assets:room")
            socket.onclose!()
            expect(closeSpy).toHaveBeenCalledOnce()
        })
        it("is triggered by socket error", () => {
            const socket = createMockSocket()
            const closeSpy = vi.spyOn(socket, "close")
            new AssetSignaling(socket, "assets:room")
            socket.onerror!(new Error("connection failed"))
            expect(closeSpy).toHaveBeenCalledOnce()
        })
    })
})
