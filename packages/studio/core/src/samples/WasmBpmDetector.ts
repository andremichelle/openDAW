import {Option, Progress} from "@opendaw/lib-std"
import {AudioData, bpm} from "@opendaw/lib-dsp"
import {BpmDetector} from "@opendaw/studio-adapters"
import {Promises} from "@opendaw/lib-runtime"
import {Workers} from "../Workers"

// Tempo measurement in the core worker (crates/stretch `tempo.rs`, shipped as stretch_wasm.wasm), so a
// long import analyses off the main thread. The module answers 0 for material with no measurable pulse
// and that is passed through as `None`: a sample whose tempo is unknown must stay unknown rather than
// acquire a plausible-looking number.
export class WasmBpmDetector implements BpmDetector {
    readonly #moduleUrl: string

    constructor(moduleUrl: string) {this.#moduleUrl = moduleUrl}

    async detect(audioData: Readonly<AudioData>, progress: Progress.Handler): Promise<Option<bpm>> {
        // `Workers.Bpm` panics outright when the worker was never installed, so the property access has to
        // sit inside the chain: thrown synchronously it would bypass tryCatch and fail the whole import.
        const {status, value, error} = await Promises.tryCatch(
            Promise.resolve().then(() => Workers.Bpm.detect(audioData, this.#moduleUrl)))
        progress(1.0)
        // Never let a missing or broken analysis module fail an import: the sample is still perfectly
        // usable without a tempo, so a failure degrades to "unknown" exactly like a negative result.
        if (status === "rejected") {
            console.warn("bpm detection unavailable:", error)
            return Option.None
        }
        return value > 0 ? Option.wrap(value) : Option.None
    }
}
