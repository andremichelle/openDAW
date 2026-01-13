import {EmptyExec, Lazy, Notifier, Nullable, Progress, unitValue} from "@moises-ai/lib-std"
import type {FFmpeg, LogEvent} from "@ffmpeg/ffmpeg"
import {Mp3Converter} from "./mp3"
import {FlacConverter} from "./flac"

export type AcceptedSource = File | Blob

export class FFmpegWorker {
    static async load(progress: Progress.Handler = Progress.Empty): Promise<FFmpegWorker> {
        return Loader.loadOrAttach(progress)
    }

    readonly #ffmpeg: FFmpeg
    readonly #progressNotifier: Notifier<unitValue>

    constructor(ffmpeg: FFmpeg) {
        this.#ffmpeg = ffmpeg
        this.#progressNotifier = new Notifier<unitValue>()
        this.#ffmpeg.on("log", ({message}: LogEvent) => console.debug("[FFmpeg]", message))
        this.#ffmpeg.on("progress", event => this.#progressNotifier.notify(event.progress))
    }

    get ffmpeg(): FFmpeg {return this.#ffmpeg}
    get loaded(): boolean {return this.#ffmpeg.loaded}
    get progressNotifier(): Notifier<unitValue> {return this.#progressNotifier}

    @Lazy
    mp3Converter(): Mp3Converter {return new Mp3Converter(this)}

    @Lazy
    flacConverter(): FlacConverter {return new FlacConverter(this)}

    async fetchFileData(source: string): Promise<Uint8Array> {
        const response = await fetch(source)
        if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.statusText}`)
        }
        return new Uint8Array(await response.arrayBuffer())
    }

    async cleanupFiles(files: string[]): Promise<void> {
        return Promise.all(files.map(file => this.#ffmpeg.deleteFile(file).catch())).then(EmptyExec)
    }
}

class Loader {
    static async loadOrAttach(progress: Progress.Handler): Promise<FFmpegWorker> {
        if (this.#loader === null) {
            this.#loader = new Loader()
        }
        const subscription = this.#loader.#progressNotifier.subscribe(progress)
        return this.#loader.load().finally(() => subscription.terminate())
    }

    static #loader: Nullable<Loader> = null

    readonly #progressNotifier = new Notifier<unitValue>()

    async load(): Promise<FFmpegWorker> {
        const {FFmpeg} = await import("@ffmpeg/ffmpeg")
        const ffmpeg = new FFmpeg()
        ffmpeg.on("log", ({type, message}: LogEvent) => {
            console.debug(`[FFmpeg ${type}]`, message)
        })
        ffmpeg.on("progress", event => {
            this.#progressNotifier.notify(event.progress)
        })
        const baseURL = "https://package.opendaw.studio" // mirror of https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm
        console.debug("[FFmpeg] Downloading core files...")
        const downloadWithProgress = async (url: string): Promise<ArrayBuffer> => {
            const response = await fetch(url)
            if (!response.ok) throw new Error(`Failed to fetch ${url}`)
            const contentLength = response.headers.get("content-length")
            const total = contentLength ? parseInt(contentLength, 10) : 0
            if (!response.body || total === 0) {
                return response.arrayBuffer()
            }
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let received = 0
            while (true) {
                const {done, value} = await reader.read()
                if (done) break
                chunks.push(value)
                received += value.length
                this.#progressNotifier.notify(received / total)
            }
            const result = new Uint8Array(received)
            let position = 0
            for (const chunk of chunks) {
                result.set(chunk, position)
                position += chunk.length
            }
            console.debug("position", position)
            return result.buffer
        }
        const coreData = await downloadWithProgress(`${baseURL}/ffmpeg-core.js`)
        const wasmData = await downloadWithProgress(`${baseURL}/ffmpeg-core.wasm`)
        console.debug("[FFmpeg] Creating blob URLs...")
        const coreBlob = new Blob([coreData], {type: "text/javascript"})
        const wasmBlob = new Blob([wasmData], {type: "application/wasm"})
        const coreURL = URL.createObjectURL(coreBlob)
        const wasmURL = URL.createObjectURL(wasmBlob)
        console.debug("[FFmpeg] Initializing...")
        await ffmpeg.load({coreURL, wasmURL})
        console.debug("[FFmpeg] Ready")
        return new FFmpegWorker(ffmpeg)
    }
}