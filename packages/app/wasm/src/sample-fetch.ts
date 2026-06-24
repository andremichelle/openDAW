import {asDefined, Procedure, unitValue, UUID} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {AudioData, WavFile} from "@opendaw/lib-dsp"

// A copy of OpenSampleAPI.load (packages/studio/core/src/samples/OpenSampleAPI.ts), trimmed to what the
// engine path needs: fetch a sample's WAV by uuid from the openDAW assets CDN (streamed, with progress) and
// decode it to PLANAR f32 AudioData. The metadata (get.php) step is skipped, since the frame count, channel
// count, and sample rate all come from decoding. Auth is the prototype Basic credential the endpoint expects
// (CORS for the wasm app is enabled server-side).
const FILE_ROOT = "https://assets.opendaw.studio/samples"
const HEADERS: RequestInit = {method: "GET", headers: {"Authorization": `Basic ${btoa("openDAW:prototype")}`}}

export const loadSample = async (uuid: UUID.Bytes, progress: Procedure<unitValue> = () => {}): Promise<AudioData> => {
    const url = `${FILE_ROOT}/${UUID.toString(uuid)}`
    const response = await Promises.retry(() => network.limitFetch(url, HEADERS))
    if (!response.ok) {
        return Promise.reject(`Failed to fetch sample ${UUID.toString(uuid)}: ${response.status} ${response.statusText}`)
    }
    const total = parseInt(response.headers.get("Content-Length") ?? "0")
    let loaded = 0
    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
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
    return WavFile.decodeFloats(arrayBuffer)
}
