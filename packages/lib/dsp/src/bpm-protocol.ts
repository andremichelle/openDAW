import {AudioData} from "./audio-data"

export interface BpmProtocol {
    // The module url travels with the call so the worker needs no separate install step and no ordering
    // rule against it: the first call compiles, later calls reuse the instance cached under that url.
    // Resolves to 0 when the material has no measurable pulse, which is the caller's "unknown".
    detect(audioData: AudioData, moduleUrl: string): Promise<number>
}
