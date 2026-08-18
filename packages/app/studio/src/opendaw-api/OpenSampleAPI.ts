import {
    asDefined,
    DefaultObservableValue,
    isDefined,
    Lazy,
    panic,
    Procedure,
    RuntimeNotifier,
    TimeSpan,
    tryCatch,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {IntervalRetryOption, network, Promises} from "@opendaw/lib-runtime"
import {Sample, SampleMetaData} from "@opendaw/studio-adapters"
import {SampleAPI} from "@opendaw/studio-core"
import {AccessKey} from "./AccessKey"
import {base64Credentials, OpenDAWHeaders} from "./OpenDAWHeaders"
import {SampleIndex} from "./SampleIndex"
import {z} from "zod"
import {AudioData, WavFile} from "@opendaw/lib-dsp"

const SampleError = z.object({error: z.string()})

// Standard openDAW samples (considered to be non-removable)
export class OpenSampleAPI implements SampleAPI {
    static readonly ApiRoot = "https://api.opendaw.studio/samples"
    static readonly FileRoot = "https://assets.opendaw.studio/samples"
    static readonly IndexFile = `${OpenSampleAPI.FileRoot}/index.json`

    @Lazy
    static get(): OpenSampleAPI {return new OpenSampleAPI()}

    // A publish must reach users on their next load, and nothing about that may depend on how a browser
    // interprets caching: the query makes every load a distinct URL, `no-cache` covers the rest.
    readonly #headers: RequestInit = {...OpenDAWHeaders, cache: "no-cache"}
    // The published index is the catalogue. A failure rejects rather than degrading to something emptier,
    // so the browser shows its retry instead of an empty list, and `memoizeAsync` drops the rejection.
    readonly #memoized: () => Promise<SampleIndex> = Promises.memoizeAsync(() =>
        Promises.retry(() => network.limitFetch(`${OpenSampleAPI.IndexFile}?v=${Date.now()}`, this.#headers),
            new IntervalRetryOption(3, TimeSpan.seconds(1)))
            .then(response => response.ok ? response.json() : panic(`${response.status} ${response.statusText}`))
            .then(json => SampleIndex.schema.parse(json)))

    private constructor() {}

    async tree(): Promise<SampleIndex> {return this.#memoized()}

    async all(): Promise<ReadonlyArray<Sample>> {return SampleIndex.flatten(await this.#memoized())}

    async get(uuid: UUID.Bytes): Promise<Sample> {
        const uuidAsString = UUID.toString(uuid)
        const known = (await this.all()).find(sample => sample.uuid === uuidAsString)
        if (isDefined(known)) {return known}
        const url = `${OpenSampleAPI.ApiRoot}/get.php?uuid=${uuidAsString}`
        const response = await Promises.retry(() => network.limitFetch(url, OpenDAWHeaders))
        if (!response.ok) {
            return panic(`Sample not found: ${uuidAsString}`)
        }
        const json = await response.json()
        const failure = SampleError.safeParse(json)
        if (failure.success) {
            return panic(failure.data.error)
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
        const accessKey = AccessKey.get().unwrap("Cannot upload without access-key.")
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
                    RuntimeNotifier.notify({message: "Upload complete.", icon: "Checkbox"})
                } else {
                    const {status, value} =
                        tryCatch(() => JSON.parse(xhr.responseText).message ?? "Unknown error message")
                    console.warn(status === "success" ? value : xhr.responseText)
                    RuntimeNotifier.notify({message: "Upload failed.", icon: "Warning"})
                }
            }
        }
        xhr.open("POST", `${OpenSampleAPI.ApiRoot}/upload.php`, true)
        xhr.setRequestHeader("Authorization", `Basic ${base64Credentials}`)
        xhr.send(formData)
    }

    allowsUpload(): boolean {return false}
}
