import {UUID} from "@opendaw/lib-std"

// The worklet -> main RPC that delivers a decoded sample into the engine's shared memory. It runs over a
// DEDICATED MessageChannel (Messenger.for owns a port's `onmessage` exclusively, and the engine port already
// carries transaction bytes + state). The worklet is the SENDER (it drives the handshake from its request
// drain), the main thread is the EXECUTOR (it fetches/decodes and writes the PLANAR f32 frames into the SAB).
export interface SampleLoader {
    // Fetch + decode the sample, hold its frames on the main thread, and report the size the engine must
    // allocate (`byteLength = frameCount * channelCount * 4`) plus the metadata for `sample_set_ready`.
    decode(uuid: UUID.Bytes): Promise<SampleInfo>
    // Copy the held planar frames into the engine's shared memory at `pointer` (channel c at
    // `pointer + c * frameCount * 4`), then release the held copy. The engine marks the sample ready after.
    write(uuid: UUID.Bytes, pointer: number): Promise<void>
}

export interface SampleInfo {
    byteLength: number
    frameCount: number
    channelCount: number
    sampleRate: number
}
