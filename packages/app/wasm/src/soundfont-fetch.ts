import {UUID} from "@opendaw/lib-std"
import {simplifySoundfont} from "./soundfont-simplify"

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
