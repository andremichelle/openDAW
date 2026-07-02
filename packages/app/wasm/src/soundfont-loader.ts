import {UUID} from "@opendaw/lib-std"

// The worklet -> main RPC that delivers a SIMPLIFIED soundfont blob into the engine's shared memory. Mirrors
// `SampleLoader`: the worklet is the SENDER (driven by its soundfont-request drain), the main thread is the
// EXECUTOR — it keeps the parsed `.sf2`, flattens it with `simplifySoundfont`, holds the blob, reports its size,
// then writes the bytes into the engine allocation. This is the seam that satisfies "TS keeps the soundfont
// file, the wasm receives a simplified data structure".
export interface SoundfontLoader {
    // Fetch + parse the soundfont, build the simplified blob, hold it on the main thread, and report the byte
    // length the engine must allocate.
    decode(uuid: UUID.Bytes): Promise<SoundfontInfo>
    // Copy the held blob bytes into the engine's shared memory at `pointer`, then release the held copy. The
    // engine marks the soundfont ready after.
    write(uuid: UUID.Bytes, pointer: number): Promise<void>
}

export interface SoundfontInfo {
    byteLength: number
}
