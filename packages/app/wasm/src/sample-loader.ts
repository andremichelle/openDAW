import {UUID} from "@opendaw/lib-std"

// The worklet -> main RPC that delivers a decoded sample. It runs over a DEDICATED MessageChannel
// (Messenger.for owns a port's `onmessage` exclusively, and the engine port already carries transaction
// bytes + state). The worklet is the SENDER (it drives the handshake from its request drain), the main
// thread is the EXECUTOR (it fetches/decodes); the WORKLET writes the frames into its own memory
// (non-shared, invisible to the main thread). The planar frames are SharedArrayBuffer-backed
// (`AudioData.create`), so the response shares them zero-copy.
export interface SampleLoader {
    decode(uuid: UUID.Bytes): Promise<SampleInfo>
}

export interface SampleInfo {
    byteLength: number
    frameCount: number
    channelCount: number
    sampleRate: number
    frames: ReadonlyArray<Float32Array>
}
