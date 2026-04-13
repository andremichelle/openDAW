import {UUID} from "@moises-ai/lib-std"

export const enum MsgType {
    ChunkData = 0x01,
    TransferStart = 0x02,
    TransferComplete = 0x03,
    ChunkAck = 0x04,
    Cancel = 0x05
}

export const CHUNK_SIZE = 65_536
export const HEADER_SIZE = 1 + UUID.length + 4 // msgType(1) + assetId(16) + chunkNum(4) = 21

export type ChunkHeader = {
    readonly msgType: MsgType
    readonly assetId: UUID.Bytes
    readonly chunkNum: number
}

export type ChunkMessage = ChunkHeader & {
    readonly payload: Uint8Array
}

export const encodeHeader = (msgType: MsgType, assetId: UUID.Bytes, chunkNum: number): ArrayBuffer => {
    const buffer = new ArrayBuffer(HEADER_SIZE)
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)
    view.setUint8(0, msgType)
    bytes.set(assetId, 1)
    view.setUint32(1 + UUID.length, chunkNum, false)
    return buffer
}

export const decodeHeader = (buffer: ArrayBuffer): ChunkHeader => {
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)
    const msgType = view.getUint8(0) as MsgType
    const assetId = new Uint8Array(bytes.buffer, 1, UUID.length) as UUID.Bytes
    const chunkNum = view.getUint32(1 + UUID.length, false)
    return {msgType, assetId, chunkNum}
}

export const encode = (msgType: MsgType, assetId: UUID.Bytes, chunkNum: number, payload: Uint8Array): ArrayBuffer => {
    const buffer = new ArrayBuffer(HEADER_SIZE + payload.byteLength)
    const bytes = new Uint8Array(buffer)
    const view = new DataView(buffer)
    view.setUint8(0, msgType)
    bytes.set(assetId, 1)
    view.setUint32(1 + UUID.length, chunkNum, false)
    bytes.set(payload, HEADER_SIZE)
    return buffer
}

export const decode = (buffer: ArrayBuffer): ChunkMessage => {
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)
    const msgType = view.getUint8(0) as MsgType
    const assetId = new Uint8Array(bytes.buffer, 1, UUID.length) as UUID.Bytes
    const chunkNum = view.getUint32(1 + UUID.length, false)
    const payload = new Uint8Array(bytes.buffer, HEADER_SIZE)
    return {msgType, assetId, chunkNum, payload}
}

export const split = (data: ArrayBuffer, chunkSize: number = CHUNK_SIZE): ReadonlyArray<Uint8Array> => {
    const bytes = new Uint8Array(data)
    const chunks: Array<Uint8Array> = []
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)))
    }
    return chunks
}

export const reassemble = (chunks: ReadonlyArray<Uint8Array>): ArrayBuffer => {
    let totalLength = 0
    for (const chunk of chunks) {
        totalLength += chunk.byteLength
    }
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result.buffer
}
