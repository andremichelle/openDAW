import {AudioData, AudioMaterialFeatures} from "@opendaw/lib-dsp"
import {Workers} from "../Workers"

// Offline material analysis in the core worker (crates/stretch, shipped as stretch_wasm.wasm): measures
// transient density, attack sharpness, tonality and grid regularity of imported audio, so a host can
// route percussive material to the granular time-stretch and sustained material to the phase vocoder.
// One-shot at import time, never on the audio thread. `Workers.install` must have run first.
export class AudioMaterialAnalyzer {
    readonly #moduleUrl: string

    constructor(moduleUrl: string) {this.#moduleUrl = moduleUrl}

    // Rejects when the analysis module cannot be loaded. Unlike tempo detection, there is no sane
    // "unknown" to degrade to, so the caller decides what a failed analysis means.
    async analyze(audioData: Readonly<AudioData>): Promise<AudioMaterialFeatures> {
        return Workers.Material.analyze(audioData, this.#moduleUrl)
    }
}