import {UUID} from "@opendaw/lib-std"
import type {SoundFont2} from "soundfont2"
import {simplifySoundfont} from "../../../studio/core-wasm/src/soundfont-simplify"

// Parse raw .sf2 bytes into a `SoundFont2` (the studio engine consumes this directly; the wasm engine gets the
// simplified blob from it). `soundfont2` is imported dynamically so it is only pulled in when actually used.
export const parseSoundfont = async (bytes: ArrayBuffer): Promise<SoundFont2> => {
    // `soundfont2` references `window` at module load; a Web Worker (and node) has no `window`, only `globalThis`.
    // Shim it before importing so the parser loads off the main thread. Harmless on the main thread (window exists).
    if (typeof (globalThis as {window?: unknown}).window === "undefined") {
        (globalThis as {window?: unknown}).window = globalThis
    }
    const {SoundFont2} = await import("soundfont2")
    return new SoundFont2(new Uint8Array(bytes))
}

// Build the wasm's simplified blob directly from raw .sf2 bytes (the bundle carries them, no network fetch).
export const simplifySoundfontBytes = async (bytes: ArrayBuffer): Promise<ArrayBuffer> =>
    simplifySoundfont(await parseSoundfont(bytes))

// The main thread keeps the SF2 FILE: fetch its bytes, parse with the `soundfont2` library, and flatten to the
// SIMPLIFIED blob the wasm engine plays. Mirrors `sample-fetch` (fetch WAV -> decode planar f32). The wasm side
// never sees the .sf2 or the parser. `soundfont2` is imported dynamically (matching the studio's lazy load) so
// it is only pulled in when a soundfont is actually used.
const FILE_ROOT = "https://assets.opendaw.studio/soundfonts"

export const loadSoundfontBlob = async (uuid: UUID.Bytes): Promise<ArrayBuffer> => {
    const id = UUID.toString(uuid)
    const response = await fetch(`${FILE_ROOT}/${id}`)
    if (!response.ok) {return Promise.reject(new Error(`soundfont ${id}: HTTP ${response.status}`))}
    const bytes = new Uint8Array(await response.arrayBuffer())
    const {SoundFont2} = await import("soundfont2")
    return simplifySoundfont(new SoundFont2(bytes))
}
