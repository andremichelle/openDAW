import {OfflineEngineRenderer, ProjectBundle, ProjectProfile, WavFile} from "@opendaw/studio-core"
import {isDefined, Option, panic, Procedure, Progress, TimeSpan} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace PublishMusic {
    export const publishMusic = async (profile: ProjectProfile, progress: Progress.Handler, log: Procedure<string>): Promise<string> => {
        const [bundleProgress, ffmpegProgress, convertProgress, uploadProgress] = Progress.split(progress, 5)
        log("Preparing project for upload...")
        const bundleResult = await Promises.tryCatch(ProjectBundle.encode(profile.copyForUpload(), bundleProgress))
        if (bundleResult.status === "rejected") {
            return panic(bundleResult.error)
        }
        const renderProgress = (seconds: number) => `Mixdown audio...(${log(TimeSpan.toHHMMSS(seconds))})`
        const mixdownResult = await Promises.tryCatch(OfflineEngineRenderer.start(profile.project, Option.None, renderProgress))
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
        const formData = new FormData()
        formData.append("mixdown", new Blob([mp3File], {type: "audio/mpeg"}), "mixdown.mp3")
        formData.append("bundle", new Blob([bundleResult.value], {type: "application/zip"}), "project.odb")
        if (isDefined(profile.meta.radioToken)) {
            formData.append("token", profile.meta.radioToken)
        }
        log("Uploading...")
        const {resolve, reject, promise} = Promise.withResolvers<string>()
        const xhr = new XMLHttpRequest()
        xhr.upload.addEventListener("progress", event => {
            if (event.lengthComputable) {
                uploadProgress(event.loaded / event.total)
            }
        })
        xhr.addEventListener("load", () => {
            if (xhr.status === 200 || xhr.status === 201) {
                const response = JSON.parse(xhr.responseText)
                profile.meta.radioToken = response.id
                profile.save()
                resolve(response.id)
            } else {
                console.warn(xhr.status, xhr.responseText)
                const error = JSON.parse(xhr.responseText)
                reject(new Error(error.error || "Upload failed"))
            }
        })
        xhr.addEventListener("error", () => reject(new Error("Network error")))
        xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")))
        xhr.open("POST", "https://api.opendaw.studio/music/upload.php")
        xhr.send(formData)
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