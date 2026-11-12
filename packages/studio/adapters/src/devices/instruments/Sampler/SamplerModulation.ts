// The values of the `source` and `target` fields of a SamplerModulationBox. WASM CONTRACT: mirrored by the engine.
export namespace SamplerModulation {
    export enum Source {AmpEnvelope, ModEnvelope, LfoA, LfoB, Velocity, Key, Random}

    export enum Target {Pitch, Cutoff, Resonance, Gain, Panning, SampleStart, LoopStart, LfoARate, LfoBRate, EnvelopeDepth}

    export const SourceNames: ReadonlyArray<string> = ["Amp Env", "Mod Env", "LFO 1", "LFO 2", "Velocity", "Key", "Random"]
    export const TargetNames: ReadonlyArray<string> =
        ["Pitch", "Cutoff", "Reso", "Gain", "Pan", "Start", "Loop", "LFO 1 Rate", "LFO 2 Rate", "Env Depth"]

    // a full amount reaches this far, Pitch in semitones, the rates in octaves, everything else in its full range
    export const PitchRange = 48.0
    export const RateRange = 4.0
}
