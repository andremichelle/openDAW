import {beforeEach, describe, expect, it, vi} from "vitest"
import {AssetSignaling, type SignalingSocket} from "../AssetSignaling"
import {AssetPeerConnection} from "../AssetPeerConnection"

class MockRTCPeerConnection {
    localDescription: unknown = null
    remoteDescription: unknown = null
    onicecandidate: unknown = null
    oniceconnectionstatechange: unknown = null
    onconnectionstatechange: unknown = null
    ondatachannel: unknown = null
    iceConnectionState = "new"
    connectionState = "new"
    createDataChannel() {return createMockChannel()}
    async createOffer() {return {type: "offer", sdp: "mock-sdp"}}
    async createAnswer() {return {type: "answer", sdp: "mock-sdp"}}
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
}

type MockChannel = {
    binaryType: string
    readyState: "connecting" | "open" | "closing" | "closed"
    bufferedAmount: number
    bufferedAmountLowThreshold: number
    onbufferedamountlow: (() => void) | null
    onopen: unknown
    onclose: unknown
    onerror: unknown
    onmessage: unknown
    sentBuffers: Array<ArrayBuffer>
    send: (data: ArrayBuffer) => void
    close: () => void
    addEventListener: (type: string, listener: () => void, options?: {once?: boolean}) => void
    removeEventListener: (type: string, listener: () => void) => void
    dispatchEvent: (type: string) => void
    __listeners: Map<string, Array<{listener: () => void, once?: boolean}>>
}

const createMockChannel = (): MockChannel => {
    const channel: MockChannel = {
        binaryType: "arraybuffer",
        readyState: "open",
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        onbufferedamountlow: null,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        sentBuffers: [],
        __listeners: new Map(),
        send(data: ArrayBuffer) {
            if (this.readyState !== "open") {
                const error = new Error("Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'")
                error.name = "InvalidStateError"
                throw error
            }
            this.sentBuffers.push(data)
        },
        close() {this.readyState = "closed"},
        addEventListener(type, listener, options) {
            const list = this.__listeners.get(type) ?? []
            list.push({listener, once: options?.once})
            this.__listeners.set(type, list)
        },
        removeEventListener(type, listener) {
            const list = this.__listeners.get(type) ?? []
            this.__listeners.set(type, list.filter(entry => entry.listener !== listener))
        },
        dispatchEvent(type: string) {
            const list = this.__listeners.get(type) ?? []
            for (const entry of list) {entry.listener()}
            this.__listeners.set(type, list.filter(entry => !entry.once))
        }
    }
    return channel
}

vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection)

const createMockSocket = (): SignalingSocket => ({
    readyState: 1,
    send() {},
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null
})

describe("AssetPeerConnection.sendWithBackpressure", () => {
    let signaling: AssetSignaling
    let connection: AssetPeerConnection
    beforeEach(() => {
        signaling = new AssetSignaling(createMockSocket(), "assets:room")
        connection = new AssetPeerConnection(signaling, "peer-A", "peer-B")
    })
    describe("channel state guard", () => {
        it("sends and returns true when channel is open and buffer below threshold", async () => {
            const channel = createMockChannel()
            const data = new ArrayBuffer(16)
            const result = await connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            expect(result).toBe(true)
            expect(channel.sentBuffers).toHaveLength(1)
            expect(channel.sentBuffers[0]).toBe(data)
        })
        it("returns false and does not call send when channel is closed", async () => {
            const channel = createMockChannel()
            channel.readyState = "closed"
            const data = new ArrayBuffer(16)
            const result = await connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            expect(result).toBe(false)
            expect(channel.sentBuffers).toHaveLength(0)
        })
        it("returns false and does not call send when channel is closing", async () => {
            const channel = createMockChannel()
            channel.readyState = "closing"
            const data = new ArrayBuffer(16)
            const result = await connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            expect(result).toBe(false)
            expect(channel.sentBuffers).toHaveLength(0)
        })
        it("returns false and does not call send when channel is connecting", async () => {
            const channel = createMockChannel()
            channel.readyState = "connecting"
            const data = new ArrayBuffer(16)
            const result = await connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            expect(result).toBe(false)
            expect(channel.sentBuffers).toHaveLength(0)
        })
        it("does not throw InvalidStateError when channel is not open", async () => {
            const channel = createMockChannel()
            channel.readyState = "closed"
            const data = new ArrayBuffer(16)
            await expect(connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data))
                .resolves.not.toThrow()
        })
    })
    describe("backpressure path", () => {
        it("waits for onbufferedamountlow before sending when buffer is high", async () => {
            const channel = createMockChannel()
            channel.bufferedAmount = 2_000_000
            const data = new ArrayBuffer(16)
            const promise = connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            // Allow the promise to set up its listener
            await Promise.resolve()
            expect(channel.sentBuffers).toHaveLength(0)
            expect(channel.onbufferedamountlow).not.toBeNull()
            // Simulate the buffer draining
            channel.bufferedAmount = 100_000
            channel.onbufferedamountlow!()
            const result = await promise
            expect(result).toBe(true)
            expect(channel.sentBuffers).toHaveLength(1)
        })
        it("returns false when channel closes while waiting for bufferedAmountLow", async () => {
            const channel = createMockChannel()
            channel.bufferedAmount = 2_000_000
            const data = new ArrayBuffer(16)
            const promise = connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            await Promise.resolve()
            // Channel closes before the buffer drains
            channel.readyState = "closed"
            channel.dispatchEvent("close")
            const result = await promise
            expect(result).toBe(false)
            expect(channel.sentBuffers).toHaveLength(0)
        })
        it("returns false when channel errors while waiting for bufferedAmountLow", async () => {
            const channel = createMockChannel()
            channel.bufferedAmount = 2_000_000
            const data = new ArrayBuffer(16)
            const promise = connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            await Promise.resolve()
            channel.readyState = "closed"
            channel.dispatchEvent("error")
            const result = await promise
            expect(result).toBe(false)
            expect(channel.sentBuffers).toHaveLength(0)
        })
        it("does not throw if bufferedAmountLow fires but channel closed in the meantime", async () => {
            const channel = createMockChannel()
            channel.bufferedAmount = 2_000_000
            const data = new ArrayBuffer(16)
            const promise = connection.sendWithBackpressure(channel as unknown as RTCDataChannel, data)
            await Promise.resolve()
            // Buffer drains but the channel has also closed (race — the close event hasn't fired yet)
            channel.readyState = "closed"
            channel.onbufferedamountlow!()
            await expect(promise).resolves.toBe(false)
            expect(channel.sentBuffers).toHaveLength(0)
        })
    })
})
