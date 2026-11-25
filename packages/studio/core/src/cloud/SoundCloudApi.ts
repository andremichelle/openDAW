import {Exec, isDefined, Nullable, Option, Progress, tryCatch} from "@opendaw/lib-std"

type SoundCloudError = {
    errors?: ReadonlyArray<{ error_message?: string }>
    message?: string
    error?: string
}

export type SoundCloudTrack = {
    id: number
    title: string
    sharing: "public" | "private"
    permalink_url: string
}

export type SoundCloudUpload = {
    title: string
    description: string
    tags: ReadonlyArray<string>
    isPrivate: boolean
    audio: Blob
    audioFileName: string
    artwork: Option<Blob>
}

export class SoundCloudApi {
    static readonly ApiUrl = "https://api.soundcloud.com"

    static formatTags(tags: ReadonlyArray<string>): string {
        return tags
            .map(tag => tag.replace(/"/g, "").trim())
            .filter(tag => tag.length > 0)
            .map(tag => tag.includes(" ") ? `"${tag}"` : tag)
            .join(" ")
    }

    readonly #accessToken: string
    readonly #onUnauthorized: Exec

    constructor(accessToken: string, onUnauthorized: Exec) {
        this.#accessToken = accessToken
        this.#onUnauthorized = onUnauthorized
    }

    upload({title, description, tags, isPrivate, audio, audioFileName, artwork}: SoundCloudUpload,
           progress: Progress.Handler, abortSignal?: AbortSignal): Promise<SoundCloudTrack> {
        const form = new FormData()
        form.append("track[title]", title)
        form.append("track[description]", description)
        form.append("track[tag_list]", SoundCloudApi.formatTags(tags))
        form.append("track[sharing]", isPrivate ? "private" : "public")
        form.append("track[asset_data]", audio, audioFileName)
        artwork.ifSome(blob => form.append("track[artwork_data]", blob, "artwork.jpg"))
        const {resolve, reject, promise} = Promise.withResolvers<SoundCloudTrack>()
        const xhr = new XMLHttpRequest()
        xhr.upload.addEventListener("progress", event => {
            if (event.lengthComputable) {progress(event.loaded / event.total)}
        })
        xhr.addEventListener("load", () => {
            const parsed = tryCatch(() => JSON.parse(xhr.responseText))
            const json: Nullable<SoundCloudTrack & SoundCloudError> = parsed.status === "success" ? parsed.value : null
            if (xhr.status >= 200 && xhr.status < 300 && isDefined(json) && isDefined(json.permalink_url)) {
                resolve(json)
            } else {
                if (xhr.status === 401) {this.#onUnauthorized()}
                reject(new Error(SoundCloudApi.#errorMessage(json, xhr)))
            }
        })
        xhr.addEventListener("error", () => reject(new Error("Network error")))
        xhr.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")))
        abortSignal?.addEventListener("abort", () => xhr.abort(), {once: true})
        xhr.open("POST", `${SoundCloudApi.ApiUrl}/tracks`)
        xhr.setRequestHeader("Authorization", `OAuth ${this.#accessToken}`)
        xhr.setRequestHeader("Accept", "application/json; charset=utf-8")
        xhr.send(form)
        return promise
    }

    static #errorMessage(json: Nullable<SoundCloudError>, xhr: XMLHttpRequest): string {
        return String(json?.errors?.at(0)?.error_message ?? json?.message ?? json?.error
            ?? `${xhr.status} ${xhr.statusText}`)
    }
}
