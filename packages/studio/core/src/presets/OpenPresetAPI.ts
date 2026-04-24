import {
    asDefined, DefaultObservableValue, isDefined, Lazy, panic, Procedure, RuntimeNotifier, tryCatch, unitValue, UUID
} from "@opendaw/lib-std"
import {network, Promises} from "@opendaw/lib-runtime"
import {base64Credentials, OpenDAWHeaders} from "../OpenDAWHeaders"
import {PresetMeta} from "./PresetMeta"

/** @internal */
export class OpenPresetAPI {
    static readonly ApiRoot = "https://api.opendaw.studio/presets"
    static readonly FileRoot = "https://assets.opendaw.studio/presets"

    @Lazy
    static get(): OpenPresetAPI {return new OpenPresetAPI()}

    private constructor() {}

    @Lazy
    async list(): Promise<ReadonlyArray<PresetMeta>> {
        const url = `${OpenPresetAPI.FileRoot}/index.json?t=${Date.now()}`
        const result = await Promises.tryCatch(Promises.retry(() =>
            network.defaultFetch(url, OpenDAWHeaders).then(response => response.json())))
        if (result.status === "rejected") {
            console.warn("OpenPresetAPI.list fetch failed", url, result.error)
            return []
        }
        if (!Array.isArray(result.value)) {
            console.warn("OpenPresetAPI.list unexpected payload", result.value)
            return []
        }
        console.info(`OpenPresetAPI.list loaded ${result.value.length} cloud preset(s)`)
        return result.value as ReadonlyArray<PresetMeta>
    }

    async load(uuid: UUID.Bytes, progress?: Procedure<unitValue>): Promise<ArrayBuffer> {
        const url = `${OpenPresetAPI.FileRoot}/${UUID.toString(uuid)}.odp`
        const response = await Promises.retry(() => network.limitFetch(url, OpenDAWHeaders))
        if (!response.ok) {
            return panic(`Failed to fetch preset ${UUID.toString(uuid)}: ${response.status} ${response.statusText}`)
        }
        if (!isDefined(progress)) {return response.arrayBuffer()}
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
                    progress(total > 0 ? loaded / total : 0)
                    reader.read().then(nextChunk, reject)
                }
            }
            reader.read().then(nextChunk, reject)
        })
    }

    async upload(arrayBuffer: ArrayBuffer, meta: PresetMeta): Promise<void> {
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Uploading", progress})
        const formData = new FormData()
        Object.entries(meta).forEach(([key, value]) => formData.set(key, String(value)))
        const params = new URLSearchParams(location.search)
        const accessKey = asDefined(params.get("access-key"), "Cannot upload without access-key.")
        formData.set("key", accessKey)
        formData.append("file", new Blob([arrayBuffer]))
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
        xhr.open("POST", `${OpenPresetAPI.ApiRoot}/upload.php`, true)
        xhr.setRequestHeader("Authorization", `Basic ${base64Credentials}`)
        xhr.send(formData)
    }
}
