import {Progress} from "@moises-ai/lib-std"
import type {AcceptedSource} from "./FFmpegWorker"

export interface FFmpegConverter<OPTIONS> {
    convert(source: AcceptedSource,
            progress: Progress.Handler,
            options?: OPTIONS): Promise<ArrayBuffer>
}