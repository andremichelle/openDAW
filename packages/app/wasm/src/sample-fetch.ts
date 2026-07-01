import {asDefined, Procedure, unitValue, UUID} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {SampleStorage} from "./sample-storage"

// A copy of OpenSampleAPI.load (packages/studio/core/src/samples/OpenSampleAPI.ts), trimmed to what the
// engine path needs: fetch a sample's WAV by uuid from the openDAW assets CDN (streamed, with progress) and
// decode it to PLANAR f32 AudioData. The metadata (get.php) step is skipped, since the frame count, channel
// count, and sample rate all come from decoding. Auth is the prototype Basic credential the endpoint expects
// (CORS for the wasm app is enabled server-side).
const FILE_ROOT = "https://assets.opendaw.studio/samples"
const HEADERS: RequestInit = {method: "GET", headers: {"Authorization": `Basic ${btoa("openDAW:prototype")}`}}

// Fetch a sample's raw WAV bytes from the cloud (streamed, with progress). Kept separate from decoding so the
// bytes can be cached before decode.
export const fetchSampleWav = async (uuid: UUID.Bytes, progress: Procedure<unitValue> = () => {}): Promise<ArrayBuffer> => {
    const url = `${FILE_ROOT}/${UUID.toString(uuid)}`
    const response = await Promises.retry(() => network.limitFetch(url, HEADERS))
    if (!response.ok) {
        return Promise.reject(`Failed to fetch sample ${UUID.toString(uuid)}: ${response.status} ${response.statusText}`)
    }
    const total = parseInt(response.headers.get("Content-Length") ?? "0")
    let loaded = 0
    return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = asDefined(response.body, "No body in response").getReader()
        const chunks: Array<Uint8Array> = []
        const nextChunk = ({done, value}: ReadableStreamReadResult<Uint8Array>) => {
            if (done) {
                resolve(new Blob(chunks as Array<BlobPart>).arrayBuffer())
            } else {
                chunks.push(value)
                loaded += value.length
                if (total > 0) {progress(loaded / total)}
                reader.read().then(nextChunk, reject)
            }
        }
        reader.read().then(nextChunk, reject)
    })
}

// Fetch + decode a sample from the cloud (no cache).
export const loadSample = async (uuid: UUID.Bytes, progress: Procedure<unitValue> = () => {}): Promise<AudioData> =>
    WavFile.decodeFloats(await fetchSampleWav(uuid, progress))

// Resolve a sample to PLANAR f32 AudioData, CACHE-FIRST: return the cached WAV (from a prior cloud fetch or an
// imported .odb bundle) if present, else fetch it from the cloud and cache the bytes for next time. This is the
// loader the engine host uses, so repeat loads and bundle samples never re-hit the network.
export const loadSampleCached = async (uuid: UUID.Bytes, progress: Procedure<unitValue> = () => {}): Promise<AudioData> => {
    const cached = await SampleStorage.readAudio(uuid)
    if (cached !== null) {return WavFile.decodeFloats(cached)}
    const wav = await fetchSampleWav(uuid, progress)
    await SampleStorage.writeAudio(uuid, wav).catch(reason => console.warn(`sample cache write failed: ${reason}`))
    return WavFile.decodeFloats(wav)
}
