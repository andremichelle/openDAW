import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    CHUNK_SIZE, decode, decodeHeader, encode, encodeHeader,
    HEADER_SIZE, MsgType, reassemble, split
} from "../ChunkProtocol"

const makeAssetId = (): UUID.Bytes => {
    const bytes = new Uint8Array(UUID.length)
    for (let index = 0; index < UUID.length; index++) {
        bytes[index] = index * 17
    }
    return bytes as UUID.Bytes
}

const makePayload = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size)
    for (let index = 0; index < size; index++) {
        bytes[index] = index & 0xFF
    }
    return bytes
}

describe("ChunkProtocol", () => {
    describe("header encode/decode", () => {
        it("roundtrips header fields", () => {
            const assetId = makeAssetId()
            const buffer = encodeHeader(MsgType.ChunkData, assetId, 42)
            expect(buffer.byteLength).toBe(HEADER_SIZE)
            const header = decodeHeader(buffer)
            expect(header.msgType).toBe(MsgType.ChunkData)
            expect(new Uint8Array(header.assetId)).toEqual(new Uint8Array(assetId))
            expect(header.chunkNum).toBe(42)
        })
        it("handles chunk number zero", () => {
            const header = decodeHeader(encodeHeader(MsgType.TransferStart, makeAssetId(), 0))
            expect(header.chunkNum).toBe(0)
        })
        it("handles large chunk numbers", () => {
            const header = decodeHeader(encodeHeader(MsgType.ChunkAck, makeAssetId(), 0xFFFFFFFF))
            expect(header.chunkNum).toBe(0xFFFFFFFF)
        })
        it("preserves all message types", () => {
            const assetId = makeAssetId()
            for (const msgType of [MsgType.ChunkData, MsgType.TransferStart, MsgType.TransferComplete, MsgType.ChunkAck, MsgType.Cancel]) {
                const header = decodeHeader(encodeHeader(msgType, assetId, 0))
                expect(header.msgType).toBe(msgType)
            }
        })
    })
    describe("message encode/decode", () => {
        it("roundtrips message with payload", () => {
            const assetId = makeAssetId()
            const payload = makePayload(128)
            const buffer = encode(MsgType.ChunkData, assetId, 7, payload)
            expect(buffer.byteLength).toBe(HEADER_SIZE + 128)
            const message = decode(buffer)
            expect(message.msgType).toBe(MsgType.ChunkData)
            expect(new Uint8Array(message.assetId)).toEqual(new Uint8Array(assetId))
            expect(message.chunkNum).toBe(7)
            expect(message.payload).toEqual(payload)
        })
        it("handles empty payload", () => {
            const message = decode(encode(MsgType.TransferComplete, makeAssetId(), 0, new Uint8Array(0)))
            expect(message.payload.byteLength).toBe(0)
        })
        it("handles large payload", () => {
            const payload = makePayload(CHUNK_SIZE)
            const message = decode(encode(MsgType.ChunkData, makeAssetId(), 1, payload))
            expect(message.payload).toEqual(payload)
        })
    })
    describe("split", () => {
        it("splits buffer into chunks of specified size", () => {
            const data = makePayload(CHUNK_SIZE * 2 + 100).buffer
            const chunks = split(data, CHUNK_SIZE)
            expect(chunks.length).toBe(3)
            expect(chunks[0].byteLength).toBe(CHUNK_SIZE)
            expect(chunks[1].byteLength).toBe(CHUNK_SIZE)
            expect(chunks[2].byteLength).toBe(100)
        })
        it("returns single chunk for data smaller than chunk size", () => {
            const data = makePayload(100).buffer
            const chunks = split(data, CHUNK_SIZE)
            expect(chunks.length).toBe(1)
            expect(chunks[0].byteLength).toBe(100)
        })
        it("returns single chunk for data exactly chunk size", () => {
            const data = makePayload(CHUNK_SIZE).buffer
            const chunks = split(data, CHUNK_SIZE)
            expect(chunks.length).toBe(1)
            expect(chunks[0].byteLength).toBe(CHUNK_SIZE)
        })
        it("handles empty buffer", () => {
            const chunks = split(new ArrayBuffer(0), CHUNK_SIZE)
            expect(chunks.length).toBe(0)
        })
    })
    describe("reassemble", () => {
        it("reassembles chunks into original buffer", () => {
            const original = makePayload(CHUNK_SIZE * 3 + 500)
            const chunks = split(original.buffer)
            const result = new Uint8Array(reassemble(chunks))
            expect(result).toEqual(original)
        })
        it("roundtrips single byte", () => {
            const original = new Uint8Array([0xAB])
            const result = new Uint8Array(reassemble(split(original.buffer)))
            expect(result).toEqual(original)
        })
        it("handles empty input", () => {
            const result = reassemble([])
            expect(result.byteLength).toBe(0)
        })
    })
    describe("split + reassemble roundtrip", () => {
        it("preserves data through split and reassemble", () => {
            const sizes = [0, 1, 100, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 5 + 12345]
            for (const size of sizes) {
                const original = makePayload(size)
                const result = new Uint8Array(reassemble(split(original.buffer)))
                expect(result).toEqual(original)
            }
        })
    })
})
