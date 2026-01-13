import {int, Progress} from "@moises-ai/lib-std"
import type {FFmpegConverter} from "./FFmpegConverter"
import type {AcceptedSource, FFmpegWorker} from "./FFmpegWorker"

// compression level (0-12, 8 is default)
export type FlacOptions = { compression: int }

export class FlacConverter implements FFmpegConverter<FlacOptions> {
    readonly #worker: FFmpegWorker

    constructor(worker: FFmpegWorker) {this.#worker = worker}
    async convert(source: AcceptedSource, progress: Progress.Handler, options?: FlacOptions): Promise<ArrayBuffer> {
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
                "-compression_level", String(options?.compression ?? 8),
                "output.flac"
            ])
            const outputData = await this.#worker.ffmpeg.readFile("output.flac")
            if (typeof outputData === "string") {
                return Promise.reject(outputData)
            }
            return new Blob([new Uint8Array(outputData)], {type: "audio/flac"}).arrayBuffer()
        } finally {
            subscription.terminate()
            await this.#worker.cleanupFiles(["input.wav", "output.flac"])
        }
    }
}