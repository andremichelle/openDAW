import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AssetSignaling, type SignalingSocket} from "../AssetSignaling"
import {AssetServer, type AssetReader} from "../AssetServer"
import {AssetPeerConnection} from "../AssetPeerConnection"
import {AssetZip} from "../AssetZip"

type MockChannel = {
    binaryType: string
    readyState: "connecting" | "open" | "closing" | "closed"
    bufferedAmount: number
    bufferedAmountLowThreshold: number
    onbufferedamountlow: (() => void) | null
    onopen: unknown
    onclose: unknown
    onerror: unknown
    onmessage: ((event: {data: string}) => void) | null
    sentBuffers: Array<ArrayBuffer>
    send: (data: ArrayBuffer) => void
    close: () => void
    addEventListener: (type: string, listener: () => void, options?: {once?: boolean}) => void
    removeEventListener: (type: string, listener: () => void) => void
    __listeners: Map<string, Array<{listener: () => void, once?: boolean}>>
}

const createMockChannel = (): MockChannel => ({
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
    }
})

let lastIncomingChannel: MockChannel | null = null

class MockRTCPeerConnection {
    localDescription: unknown = null
    remoteDescription: unknown = null
    onicecandidate: unknown = null
    oniceconnectionstatechange: unknown = null
    onconnectionstatechange: unknown = null
    ondatachannel: ((event: {channel: unknown}) => void) | null = null
    iceConnectionState = "new"
    connectionState = "new"
    createDataChannel() {return createMockChannel()}
    async createOffer() {return {type: "offer", sdp: "mock-sdp"}}
    async createAnswer() {return {type: "answer", sdp: "mock-sdp"}}
    async setLocalDescription() {}
    async setRemoteDescription(description: {type: string}) {
        if (description.type === "offer" && this.ondatachannel !== null) {
            const channel = createMockChannel()
            lastIncomingChannel = channel
            const ondatachannel = this.ondatachannel
            queueMicrotask(() => ondatachannel({channel}))
        }
    }
    async addIceCandidate() {}
    close() {}
}

vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection)

type MockSocket = SignalingSocket & {
    sent: Array<string>
    simulateMessage: (data: string) => void
}

const createMockSocket = (): MockSocket => ({
    sent: [],
    readyState: 1,
    send(data: string) {this.sent.push(data)},
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    simulateMessage(data: string) {
        if (this.onmessage !== null) {this.onmessage({data})}
    }
})

const publishEnvelope = (topic: string, message: Record<string, unknown>): string =>
    JSON.stringify({type: "publish", topic, data: message})

const createMockAssetReader = (sf2Size: number): AssetReader => ({
    hasSample: async () => false,
    hasSoundfont: async () => true,
    readSample: async () => {throw new Error("not used")},
    readSoundfont: async (uuid: UUID.Bytes) => [new ArrayBuffer(sf2Size), {
        uuid: UUID.toString(uuid),
        name: "test-font",
        type: "soundfont" as const
    } as never]
})

const openConnection = async (
    socket: MockSocket,
    remotePeer: string,
    localPeer: string
): Promise<MockChannel> => {
    socket.simulateMessage(publishEnvelope("assets:room", {
        type: "rtc-offer",
        peerId: remotePeer,
        targetPeerId: localPeer,
        sdp: "mock-offer-sdp"
    }))
    for (let tick = 0; tick < 100; tick++) {
        if (lastIncomingChannel !== null && typeof lastIncomingChannel.onmessage === "function") {break}
        await Promise.resolve()
    }
    const channel = lastIncomingChannel
    if (channel === null) {throw new Error("channel not established in mock")}
    if (typeof channel.onmessage !== "function") {throw new Error("channel.onmessage not assigned by server")}
    return channel
}

describe("AssetServer channel-close safety", () => {
    beforeEach(() => {lastIncomingChannel = null})
    afterEach(() => {vi.restoreAllMocks()})

    it("stops after TransferStart when sendWithBackpressure returns false", async () => {
        // Mock packing so we don't depend on real JSZip timing.
        vi.spyOn(AssetZip, "packSoundfont").mockResolvedValue(new ArrayBuffer(4 * 65_536))
        const sendSpy = vi.spyOn(AssetPeerConnection.prototype, "sendWithBackpressure")
            .mockResolvedValue(false as unknown as void)
        const {promise: transferSettled, resolve: settle} = Promise.withResolvers<void>()
        sendSpy.mockImplementation(async () => {settle(); return false})
        const socket = createMockSocket()
        const signaling = new AssetSignaling(socket, "assets:room")
        const reader = createMockAssetReader(4 * 65_536)
        const server = new AssetServer(signaling, "peer-local", reader)
        const uuid = UUID.generate()
        const channel = await openConnection(socket, "peer-remote", "peer-local")
        channel.onmessage!({data: JSON.stringify({
            type: "transfer-request",
            uuid: UUID.toString(uuid),
            assetType: "soundfont"
        })})
        await transferSettled
        // Flush any follow-up microtasks so if the loop kept going, it'd still show up.
        for (let tick = 0; tick < 20; tick++) {await Promise.resolve()}
        // Only the TransferStart call happened; the chunk loop and TransferComplete were skipped.
        expect(sendSpy).toHaveBeenCalledTimes(1)
        server.terminate()
    })

    it("stops mid-chunk-loop when sendWithBackpressure returns false", async () => {
        vi.spyOn(AssetZip, "packSoundfont").mockResolvedValue(new ArrayBuffer(4 * 65_536))
        let callCount = 0
        const {promise: loopAborted, resolve: signalAborted} = Promise.withResolvers<void>()
        vi.spyOn(AssetPeerConnection.prototype, "sendWithBackpressure")
            .mockImplementation(async () => {
                callCount++
                // 1st call: TransferStart (true). 2nd call: first chunk (false → should abort).
                if (callCount === 2) {signalAborted()}
                return callCount === 1
            })
        const socket = createMockSocket()
        const signaling = new AssetSignaling(socket, "assets:room")
        const reader = createMockAssetReader(4 * 65_536)
        const server = new AssetServer(signaling, "peer-local", reader)
        const uuid = UUID.generate()
        const channel = await openConnection(socket, "peer-remote", "peer-local")
        channel.onmessage!({data: JSON.stringify({
            type: "transfer-request",
            uuid: UUID.toString(uuid),
            assetType: "soundfont"
        })})
        await loopAborted
        for (let tick = 0; tick < 20; tick++) {await Promise.resolve()}
        // Expected: TransferStart + first chunk (= 2). No further chunks, no TransferComplete.
        expect(callCount).toBe(2)
        server.terminate()
    })

    it("does not attempt channel.send when the channel has closed before packing completes", async () => {
        // Force the pack step to await a signal the test controls, so we can close the channel first.
        const {promise: releasePack, resolve: finishPack} = Promise.withResolvers<ArrayBuffer>()
        vi.spyOn(AssetZip, "packSoundfont").mockImplementation(() => releasePack)
        const socket = createMockSocket()
        const signaling = new AssetSignaling(socket, "assets:room")
        const reader = createMockAssetReader(4 * 65_536)
        const server = new AssetServer(signaling, "peer-local", reader)
        const uuid = UUID.generate()
        const channel = await openConnection(socket, "peer-remote", "peer-local")
        let sendAttempts = 0
        channel.send = (_data: ArrayBuffer) => {
            sendAttempts++
            if (channel.readyState !== "open") {
                const error = new Error("Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'")
                error.name = "InvalidStateError"
                throw error
            }
        }
        channel.onmessage!({data: JSON.stringify({
            type: "transfer-request",
            uuid: UUID.toString(uuid),
            assetType: "soundfont"
        })})
        // Close the channel before the pack resolves, then let the pack finish.
        channel.readyState = "closed"
        finishPack(new ArrayBuffer(4 * 65_536))
        for (let tick = 0; tick < 50; tick++) {await Promise.resolve()}
        // Fixed behavior: zero attempts. Current buggy behavior: attempts once and throws.
        expect(sendAttempts).toBe(0)
        server.terminate()
    })
})
