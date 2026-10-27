import {OfflineEngineRenderer, ProjectBundle, ProjectProfile} from "@opendaw/studio-core"
import {WavFile} from "@opendaw/lib-dsp"
import {
    DefaultObservableValue,
    isDefined,
    Option,
    panic,
    Procedure,
    Progress,
    RuntimeNotifier,
    tryCatch
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace PublishMusic {
    const MusicApi = "https://api.opendaw.studio/music"
    // the host refuses request bodies over 8 MiB
    const UploadChunkSize = 4 << 20

    export const publishMusic = async (profile: ProjectProfile, progress: Progress.Handler, log: Procedure<string>): Promise<string> => {
        const [bundleProgress, ffmpegProgress, convertProgress, uploadProgress] = Progress.split(progress, 5)
        log("Preparing project for upload...")
        const bundleResult = await Promises.tryCatch(ProjectBundle.encode(profile.copyForUpload(), bundleProgress))
        if (bundleResult.status === "rejected") {
            return panic(bundleResult.error)
        }
        log("Mixdown audio...")
        const renderProgress = new DefaultObservableValue(0.0)
        const mixdownResult = await Promises.tryCatch(OfflineEngineRenderer.start(profile.project.copy(), Option.None, renderProgress, undefined, 48_000))
        if (mixdownResult.status === "rejected") {
            return panic(mixdownResult.error)
        }
        log("Loading FFmpeg...")
        const {FFmpegWorker} = await Promises.guardedRetry(() =>
            import("@opendaw/studio-core/FFmpegWorker"), (_, count) => count < 10)
        const ffmpegResult = await Promises.tryCatch(FFmpegWorker.load(ffmpegProgress))
        if (ffmpegResult.status === "rejected") {
            return panic(ffmpegResult.error)
        }
        log("Converting to MP3...")
        const mp3File = await ffmpegResult.value.mp3Converter()
            .convert(new Blob([WavFile.encodeFloats(mixdownResult.value)]), convertProgress)
        log("Uploading...")
        const upload = Array.from(crypto.getRandomValues(new Uint8Array(16)),
            byte => byte.toString(16).padStart(2, "0")).join("")
        const files: ReadonlyArray<[string, ArrayBuffer]> = [["mixdown", mp3File], ["bundle", bundleResult.value]]
        const total = files.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0)
        for (const [index, [file, bytes]] of files.entries()) {
            const before = files.slice(0, index).reduce((sum, [, previous]) => sum + previous.byteLength, 0)
            for (let offset = 0; offset < bytes.byteLength; offset += UploadChunkSize) {
                const chunk = bytes.slice(offset, offset + UploadChunkSize)
                await Promises.guardedRetry(() => post(`${MusicApi}/upload-chunk.php?upload=${upload}&file=${file}&offset=${offset}`,
                    chunk, "application/octet-stream", loaded => uploadProgress((before + offset + loaded) / total)),
                    (_, count) => count < 3)
                uploadProgress((before + offset + chunk.byteLength) / total)
            }
        }
        const fields = new URLSearchParams({upload})
        if (isDefined(profile.meta.radioToken)) {
            fields.set("token", profile.meta.radioToken)
        }
        const {id} = await post(`${MusicApi}/upload.php`, fields, "application/x-www-form-urlencoded")
        if (!isDefined(id)) {return panic("Upload answered without an id")}
        profile.meta.radioToken = id
        Promises.tryCatch(profile.save()).then(({status, error}) => {
            if (status === "rejected") {
                RuntimeNotifier.info({
                    headline: "Storage Unavailable",
                    message: `The upload succeeded, but the publish token could not be saved locally (${String(error)}). Future publishes from this project will create a new entry instead of updating this one.`
                }).finally()
            }
        })
        return id
    }

    const post = (url: string, body: XMLHttpRequestBodyInit, contentType: string,
                  progress: Procedure<number> = () => {}): Promise<{ id?: string, error?: string }> => {
        const {resolve, reject, promise} = Promise.withResolvers<{ id?: string, error?: string }>()
        const xhr = new XMLHttpRequest()
        xhr.upload.addEventListener("progress", event => {
            if (event.lengthComputable) {progress(event.loaded)}
        })
        xhr.addEventListener("load", () => {
            const parsed = tryCatch(() => JSON.parse(xhr.responseText))
            const result = parsed.status === "success" ? parsed.value : {}
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(result)
            } else {
                reject(new Error(String(result?.error ?? `${xhr.status} ${xhr.statusText}`)))
            }
        })
        xhr.addEventListener("error", () => reject(new Error("Network error")))
        xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")))
        xhr.open("POST", url)
        xhr.setRequestHeader("Content-Type", contentType)
        xhr.send(body)
        return promise
    }

    export const deleteMusic = async (token: string): Promise<void> => {
        const formData = new FormData()
        formData.append("token", token)
        const response = await fetch("https://api.opendaw.studio/music/delete.php", {
            method: "POST",
            body: formData
        })
        if (!response.ok) {
            const error = await response.json()
            throw new Error(error.error || "Delete failed")
        }
    }
}