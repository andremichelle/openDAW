import {DefaultObservableValue, int, isDefined, Option, Procedure, Progress} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {OfflineEngineRenderer, Project, ProjectBundle, ProjectProfile} from "@opendaw/studio-core"
import {AudioFormats} from "@/audio/AudioFormats"

export namespace Contest {
    export type Prize = Readonly<{ place: string, label: string, detail: string, url?: string }>
    export type Consent = Readonly<{ id: string, label: string }>
    export type TermsSection = Readonly<{ heading: string, text: string }>

    export type Definition = Readonly<{
        name: string
        eyebrow: string
        title: string
        intro: string
        deadline: string
        deadlineLabel: string
        brief: string
        bonus: string
        prizes: ReadonlyArray<Prize>
        prizeNote: string
        rules: ReadonlyArray<string>
        maxBytes: int
        maxSeconds: int
        cooldownHours: int
        consents: ReadonlyArray<Consent>
        terms: Readonly<{ version: int, sections: ReadonlyArray<TermsSection> }>
        serverTime: number
    }>

    export type Entrant = Readonly<{ name: string, email: string }>

    export type Step = "Bundling project" | "Rendering mixdown" | "Encoding Opus" | "Uploading"

    export class Failure extends Error {
        readonly code: string
        readonly retryAfter: Option<int>

        constructor(message: string, code: string, retryAfter: Option<int>) {
            super(message)
            this.code = code
            this.retryAfter = retryAfter
        }
    }

    type ServerReply = Readonly<{
        error?: string, code?: string, retryAfter?: int, received?: int,
        upload?: string, token?: string, chunkBytes?: int, id?: string
    }>

    const Api = "https://api.opendaw.studio/contests"

    const BestOpus: AudioFormats.OpusSettings = {
        numberOfChannels: 2, bitrate: 510, complexity: 10, frameDuration: 20_000, variable: true, application: "audio"
    }

    const NetworkFailure = new Failure("The connection to the server failed. Please check your connection and try again.",
        "network", Option.None)

    const request = async (url: string, init: RequestInit): Promise<[int, ServerReply]> => {
        const response = await Promises.tryCatch(fetch(url, init))
        if (response.status === "rejected") {throw NetworkFailure}
        const reply = await Promises.tryCatch(response.value.json())
        return [response.value.status, reply.status === "resolved" ? reply.value : {}]
    }

    const UnknownContest = new Failure("This contest does not exist.", "unknown-contest", Option.None)

    const failureOf = (status: int, reply: ServerReply): Failure => new Failure(
        reply.error ?? `The server answered with an unexpected error (${status}). Please try again later.`,
        reply.code ?? "unknown", Option.wrap(reply.retryAfter))

    export const load = async (name: string): Promise<Definition> => {
        if (!/^[a-z0-9-]{1,32}$/.test(name)) {throw UnknownContest}
        const response = await Promises.tryCatch(fetch(`${Api}/${name}/contest.json`, {cache: "no-cache"}))
        if (response.status === "rejected") {throw NetworkFailure}
        if (response.value.status === 404) {throw UnknownContest}
        if (!response.value.ok) {
            throw new Failure(`The server answered with an unexpected error (${response.value.status}). Please try again later.`,
                "unknown", Option.None)
        }
        const json = await Promises.tryCatch(response.value.json())
        if (json.status === "rejected") {throw UnknownContest}
        const date = Date.parse(response.value.headers.get("Date") ?? "")
        const definition: Definition = {...json.value, serverTime: Number.isNaN(date) ? Date.now() : date}
        return definition
    }

    export const songSeconds = (project: Project): number =>
        project.tempoMap.intervalToSeconds(0, project.lastRegionAction())

    export const submit = async (contest: Definition, profile: ProjectProfile, entrant: Entrant,
                                 onStep: Procedure<Step>, progress: Progress.Handler): Promise<string> => {
        const [bundleProgress, renderProgress, encodeProgress, uploadProgress] = Progress.split(progress, 4)
        onStep("Bundling project")
        const bundle = await ProjectBundle.encode(profile.copyForUpload(), bundleProgress)
        onStep("Rendering mixdown")
        const renderValue = new DefaultObservableValue(0.0)
        const renderSubscription = renderValue.subscribe(owner => renderProgress(owner.getValue()))
        const audio = await OfflineEngineRenderer.start(profile.project.copy(), Option.None, renderValue, undefined,
            AudioFormats.OpusSampleRate).finally(() => renderSubscription.terminate())
        onStep("Encoding Opus")
        const webCodecs = await AudioFormats.isOpusSupported(BestOpus)
        const mixdown = webCodecs
            ? await AudioFormats.encodeOpus(audio, BestOpus, encodeProgress)
            : await encodeWithFFmpeg(audio, encodeProgress)
        const total = mixdown.byteLength + bundle.byteLength
        if (total > contest.maxBytes) {
            throw new Failure(`Your submission is ${megabytes(total)}, the limit is ${megabytes(contest.maxBytes)}. Remove unused samples and try again.`,
                "too-large", Option.None)
        }
        onStep("Uploading")
        const [startStatus, started] = await request(`${Api}/start.php`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                contest: contest.name, name: entrant.name, email: entrant.email, projectName: profile.meta.name,
                termsVersion: contest.terms.version, encoder: webCodecs ? "webcodecs" : "ffmpeg",
                consents: Object.fromEntries(contest.consents.map(({id}) => [id, true])),
                mixdownBytes: mixdown.byteLength, bundleBytes: bundle.byteLength
            })
        })
        const {upload, token, chunkBytes} = started
        if (startStatus !== 200 || !isDefined(upload) || !isDefined(token) || !isDefined(chunkBytes)) {
            throw failureOf(startStatus, started)
        }
        const query = `upload=${upload}&token=${token}`
        const files: ReadonlyArray<[string, ArrayBuffer]> = [["mixdown", mixdown], ["bundle", bundle]]
        let sent = 0
        for (const [file, bytes] of files) {
            for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
                const chunk = bytes.slice(offset, offset + chunkBytes)
                await Promises.guardedRetry(() => sendChunk(`${Api}/upload-chunk.php?${query}&file=${file}&offset=${offset}`,
                    chunk, offset), (error, count) => error === NetworkFailure && count < 3)
                sent += chunk.byteLength
                uploadProgress(sent / total)
            }
        }
        const [finishStatus, finished] = await request(`${Api}/finish.php?${query}`, {method: "POST"})
        if (finishStatus !== 200 || !isDefined(finished.id)) {throw failureOf(finishStatus, finished)}
        return finished.id
    }

    const sendChunk = async (url: string, chunk: ArrayBuffer, offset: int): Promise<void> => {
        const [status, reply] = await request(url, {
            method: "POST", headers: {"Content-Type": "application/octet-stream"}, body: chunk
        })
        // a retry after a lost answer finds the chunk already stored
        if (status === 200 || (status === 409 && reply.received === offset + chunk.byteLength)) {return}
        throw failureOf(status, reply)
    }

    const encodeWithFFmpeg = async (audio: AudioData, progress: Progress.Handler): Promise<ArrayBuffer> => {
        const [loadProgress, convertProgress] = Progress.split(progress, 2)
        const {FFmpegWorker} = await Promises.guardedRetry(() =>
            import("@opendaw/studio-core/FFmpegWorker"), (_, count) => count < 10)
        const worker = await FFmpegWorker.load(loadProgress)
        return worker.opusConverter().convert(new Blob([WavFile.encodeFloats(audio)]), convertProgress,
            {bitrate: BestOpus.bitrate, complexity: BestOpus.complexity})
    }

    const megabytes = (bytes: int): string => `${Math.ceil(bytes / 1048576)} MB`
}
