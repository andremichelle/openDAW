import {
    asDefined,
    DefaultObservableValue,
    Lazy,
    panic,
    Procedure,
    RuntimeNotifier,
    tryCatch,
    unitValue,
    UUID
} from "@moises-ai/lib-std"
import {network, Promises} from "@moises-ai/lib-runtime"
import {Sample, SampleMetaData} from "@moises-ai/studio-adapters"
import {SampleAPI} from "@moises-ai/studio-core"
import {base64Credentials, OpenDAWHeaders} from "../OpenDAWHeaders"
import {z} from "zod"
import {AudioData} from "@moises-ai/lib-dsp"
import {WavFile} from "../WavFile"

// Standard openDAW samples (considered to be non-removable)
export class OpenSampleAPI implements SampleAPI {
    static readonly ApiRoot = "https://api.opendaw.studio/samples"
    static readonly FileRoot = "https://assets.opendaw.studio/samples"

    @Lazy
    static get(): OpenSampleAPI {return new OpenSampleAPI()}

    private constructor() {}

    @Lazy
    async all(): Promise<ReadonlyArray<Sample>> {
        return network.defaultFetch(`${OpenSampleAPI.ApiRoot}/list.php`, OpenDAWHeaders)
            .then(x => x.json().then(x => z.array(Sample).parse(x)), () => [])
    }

    async get(uuid: UUID.Bytes): Promise<Sample> {
        const url = `${OpenSampleAPI.ApiRoot}/get.php?uuid=${UUID.toString(uuid)}`
        const response = await Promises.retry(() => network.limitFetch(url, OpenDAWHeaders))
        if (!response.ok) {
            return panic(`Sample not found: ${UUID.toString(uuid)}`)
        }
        const json = await response.json()
        if ("error" in json) {
            return panic(json.error)
        }
        const sample = Sample.parse(json)
        return Object.freeze({...sample, origin: "openDAW"})
    }

    async load(uuid: UUID.Bytes, progress: Procedure<unitValue>): Promise<[AudioData, Sample]> {
        console.debug(`load ${UUID.toString(uuid)}`)
        return this.get(uuid)
            .then(({uuid, name, bpm}) => Promises.retry(() => network
                .limitFetch(`${OpenSampleAPI.FileRoot}/${uuid}`, OpenDAWHeaders))
                .then(response => {
                    if (!response.ok) {
                        return panic(`Failed to fetch sample ${uuid}: ${response.status} ${response.statusText}`)
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
                                progress(loaded / total)
                                reader.read().then(nextChunk, reject)
                            }
                        }
                        reader.read().then(nextChunk, reject)
                    })
                })
                .then(arrayBuffer => {
                    const audioData = WavFile.decodeFloats(arrayBuffer)
                    return [audioData, {
                        uuid,
                        bpm,
                        name,
                        duration: audioData.numberOfFrames / audioData.sampleRate,
                        sample_rate: audioData.sampleRate,
                        origin: "openDAW"
                    }] as [AudioData, Sample]
                }))
    }

    async upload(arrayBuffer: ArrayBuffer, metaData: SampleMetaData): Promise<void> {
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Uploading", progress})
        const formData = new FormData()
        Object.entries(metaData).forEach(([key, value]) => formData.set(key, String(value)))
        const params = new URLSearchParams(location.search)
        const accessKey = asDefined(params.get("access-key"), "Cannot upload without access-key.")
        formData.set("key", accessKey)
        formData.append("file", new Blob([arrayBuffer]))
        console.log("upload data", Array.from(formData.entries()), arrayBuffer.byteLength)
        const xhr = new XMLHttpRequest()
        xhr.upload.addEventListener("progress", (event: ProgressEvent) => {
            if (event.lengthComputable) {
                progress.setValue(event.loaded / event.total)
            }
        })
        xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
                dialog.terminate()
                if (xhr.status === 200) {
                    RuntimeNotifier.info({message: xhr.responseText})
                } else {
                    const {status, value} =
                        tryCatch(() => JSON.parse(xhr.responseText).message ?? "Unknown error message")
                    RuntimeNotifier.info({
                        headline: "Upload Failure",
                        message: status === "success" ? value : "Unknown error"
                    })
                }
            }
        }
        xhr.open("POST", `${OpenSampleAPI.ApiRoot}/upload.php`, true)
        xhr.setRequestHeader("Authorization", `Basic ${base64Credentials}`)
        xhr.send(formData)
    }

    allowsUpload(): boolean {return false}
}