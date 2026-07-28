import {UUID} from "@opendaw/lib-std"

// The soundfont analog of `SampleLoader`: the main thread keeps the parsed `.sf2`, flattens it with
// `simplifySoundfont` and returns the simplified blob; the WORKLET writes it into its own memory. This is
// the seam that satisfies "TS keeps the soundfont file, the wasm receives a simplified data structure".
export interface SoundfontLoader {
    decode(uuid: UUID.Bytes): Promise<SoundfontInfo>
}

export interface SoundfontInfo {
    byteLength: number
    blob: Uint8Array
}
