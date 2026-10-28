import {DefaultObservableValue, Errors, isNull, Option, RuntimeNotifier, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {OfflineEngineRenderer, ProjectProfile, SoundCloudTrack} from "@opendaw/studio-core"
import {WavFile} from "@opendaw/lib-dsp"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"
import {SoundCloudOptions} from "@/ui/info-panel/SoundCloudOptions"

export namespace UploadSoundCloud {
    const Attribution = "Made with openDAW https://opendaw.studio"
    const AttributionTag = "openDAW"
    const SampleRate = 48_000
    const uploadPrivately = new DefaultObservableValue<boolean>(true)

    export const upload = async (service: StudioService, profile: ProjectProfile): Promise<void> => {
        const lifecycle = new Terminator()
        const {status: dialogStatus, error: dialogError} = await Promises.tryCatch(Dialogs.show({
            headline: "Upload to SoundCloud",
            content: SoundCloudOptions({lifecycle, isPrivate: uploadPrivately}),
            okText: "Upload"
        }))
        lifecycle.terminate()
        if (dialogStatus === "rejected") {
            if (Errors.isAbort(dialogError)) {return}
            throw dialogError
        }
        const loginResult = await Promises.tryCatch(service.cloudAuthManager.soundCloud())
        if (loginResult.status === "rejected") {
            if (isNull(loginResult.error) || loginResult.error === "cancelled") {return}
            return RuntimeNotifier.info({headline: "SoundCloud Login Failed", message: String(loginResult.error)})
        }
        const isPrivate = uploadPrivately.getValue()
        const {meta, cover} = profile
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Upload to SoundCloud",
            message: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const result = await Promises.tryCatch((async (): Promise<SoundCloudTrack> => {
            const audioData = await OfflineEngineRenderer.start(
                profile.project.copy(), Option.None, progress, abortController.signal, SampleRate)
            const audio = new Blob([WavFile.encodeInts24(audioData)], {type: "audio/wav"})
            const artwork = await cover.match({none: async () => Option.None, some: encodeArtwork})
            dialog.message = "Uploading..."
            progress.setValue(0.0)
            const name = meta.name.trim()
            const tags = meta.tags.some(tag => tag.toLowerCase() === AttributionTag.toLowerCase())
                ? meta.tags : [...meta.tags, AttributionTag]
            return loginResult.value.upload({
                title: name.length > 0 ? name : "Untitled",
                description: meta.description.trim().length > 0 ? `${meta.description.trim()}\n\n${Attribution}` : Attribution,
                tags,
                isPrivate,
                audio,
                audioFileName: `${name.length > 0 ? name : "mixdown"}.wav`,
                artwork
            }, value => progress.setValue(value), abortController.signal)
        })())
        dialog.terminate()
        if (result.status === "rejected") {
            if (Errors.isAbort(result.error)) {return}
            return RuntimeNotifier.info({headline: "Upload to SoundCloud Failed", message: String(result.error)})
        }
        const track = result.value
        const open = await RuntimeNotifier.approve({
            headline: "Uploaded to SoundCloud",
            message: `'${track.title}' is on SoundCloud${track.sharing === "private" ? " as a private track" : ""}.`,
            approveText: "Open",
            cancelText: "Close"
        })
        if (open) {window.open(track.permalink_url, "_blank")}
    }

    // SoundCloud takes JPEG or PNG artwork, the project cover is WebP
    const encodeArtwork = async (buffer: ArrayBuffer): Promise<Option<Blob>> => {
        if (buffer.byteLength === 0) {return Option.None}
        const {status, value} = await Promises.tryCatch((async () => {
            const bitmap = await createImageBitmap(new Blob([buffer]))
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
            bitmap.close()
            return canvas.convertToBlob({type: "image/jpeg", quality: 0.92})
        })())
        return status === "resolved" ? Option.wrap(value) : Option.None
    }
}
