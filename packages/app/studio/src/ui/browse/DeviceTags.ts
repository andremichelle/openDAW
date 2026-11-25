import {Arrays} from "@opendaw/lib-std"

export namespace DeviceTags {
    const Stock: Readonly<Record<string, ReadonlyArray<string>>> = {
        Apparat: ["synth", "script"],
        Cubed: ["synth", "fm"],
        InstrumentComposite: ["layer", "utility"],
        Neon: ["synth", "phase-distortion"],
        Tubular: ["synth", "subtractive"],
        MIDIOutput: ["midi", "hardware", "utility"],
        Nano: ["sampler"],
        Playfield: ["drums", "sampler"],
        Soundfont: ["sampler", "general-midi"],
        Tape: ["audio", "playback"],
        Vaporisateur: ["synth", "subtractive"],
        Wclap: ["plugin"],
        Arpeggio: ["arpeggiator", "pattern"],
        Pitch: ["pitch", "transpose"],
        Spielwerk: ["script"],
        Velocity: ["velocity", "dynamics"],
        Zeitgeist: ["groove", "shuffle", "timing"],
        AudioEffectComposite: ["parallel", "routing"],
        StereoComposite: ["stereo", "routing"],
        FrequencySplit: ["multiband", "routing"],
        Autotune: ["pitch", "vocal"],
        Compressor: ["dynamics", "mixing"],
        Convolver: ["reverb", "space"],
        Crusher: ["distortion", "lo-fi"],
        DattorroReverb: ["reverb", "space"],
        Delay: ["delay", "echo", "space"],
        Fold: ["distortion", "wavefolder"],
        Reverb: ["reverb", "space"],
        Gate: ["dynamics", "gate"],
        Maximizer: ["dynamics", "limiter", "mastering"],
        Revamp: ["eq", "filter", "mixing"],
        StereoTool: ["stereo", "panning", "mixing"],
        Tidal: ["modulation", "tremolo", "panning"],
        NeuralAmp: ["distortion", "amp", "guitar"],
        Vocoder: ["vocal", "modulation"],
        Waveshaper: ["distortion", "saturation"],
        Werkstatt: ["script"],
        Sink: ["routing", "utility"],
        Modular: ["modular"]
    }

    export const of = (deviceKey: string): ReadonlyArray<string> => Stock[deviceKey] ?? Arrays.empty()
}
