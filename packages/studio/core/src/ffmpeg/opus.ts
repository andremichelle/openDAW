import {int, Progress} from "@opendaw/lib-std"
import type {FFmpegConverter} from "./FFmpegConverter"
import type {AcceptedSource, FFmpegWorker} from "./FFmpegWorker"

// bitrate in kbps, complexity 0 (fast) to 10 (best)
export type OpusOptions = { bitrate: int, complexity: int }

export class OpusConverter implements FFmpegConverter<OpusOptions> {
    readonly #worker: FFmpegWorker

    constructor(worker: FFmpegWorker) {this.#worker = worker}
    async convert(source: AcceptedSource, progress: Progress.Handler, options?: OpusOptions): Promise<ArrayBuffer> {
        const subscription = this.#worker.progressNotifier.subscribe(progress)
        try {
            let inputData: Uint8Array
            if (source instanceof File || source instanceof Blob) {
                inputData = new Uint8Array(await source.arrayBuffer())
            } else {
                inputData = await this.#worker.fetchFileData(source)
            }
            await this.#worker.ffmpeg.writeFile("input.wav", inputData)
            await this.#worker.ffmpeg.exec([
                "-y",
                "-i", "input.wav",
                "-c:a", "libopus",
                "-b:a", `${options?.bitrate ?? 160}k`,
                "-vbr", "on",
                "-compression_level", String(options?.complexity ?? 10),
                "-application", "audio",
                "output.opus"
            ])
            const outputData = await this.#worker.ffmpeg.readFile("output.opus")
            if (typeof outputData === "string") {
                return Promise.reject(outputData)
            }
            return new Blob([new Uint8Array(outputData)], {type: "audio/ogg"}).arrayBuffer()
        } finally {
            subscription.terminate()
            await this.#worker.cleanupFiles(["input.wav", "output.opus"])
        }
    }
}
