import {Arrays, isDefined} from "@opendaw/lib-std"

export namespace DeviceTags {
    const Stock: Readonly<Record<string, ReadonlyArray<string>>> = {
        Apparat: ["synth", "script"],
        Cubed: ["synth", "fm"],
        Guitar: ["guitar", "strum", "physical-modeling"],
        InstrumentComposite: ["layer", "utility"],
        Neon: ["synth", "phase-distortion"],
        Tubular: ["synth", "subtractive"],
        Surgeon: ["synth", "fm"],
        OpenDrumKick: ["drums", "synth"],
        OpenDrumPerc: ["drums", "synth", "fm"],
        OpenDrumBell: ["drums", "synth"],
        OpenDrumCymbal: ["drums", "synth"],
        OpenDrumShaker: ["drums", "synth"],
        OpenDrumHat: ["drums", "synth"],
        OpenDrumRim: ["drums", "synth"],
        OpenDrumTom: ["drums", "synth"],
        OpenDrumClap: ["drums", "synth"],
        OpenDrumSnare: ["drums", "synth"],
        MIDIOutput: ["midi", "hardware", "utility"],
        Nano: ["sampler"],
        Sampler: ["sampler"],
        Playfield: ["drums", "sampler"],
        Soundfont: ["sampler", "general-midi"],
        Tape: ["audio", "playback"],
        Vaporisateur: ["synth", "subtractive"],
        Wclap: ["plugin"],
        Arpeggio: ["arpeggiator", "pattern"],
        Euclid: ["generative", "rhythm"],
        Pitch: ["pitch", "transpose"],
        Spielwerk: ["script", "utility"],
        NoteFilter: ["key-range", "utility"],
        ScaleMatrix: ["scale", "utility"],
        ChordKeys: ["utility"],
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

    export type Tag = { readonly name: string, readonly variants: ReadonlyArray<string> }

    export const List: ReadonlyArray<Tag> = [
        {name: "Synth", variants: ["synth", "synthesizer", "analog", "virtual analog", "fm", "subtractive", "additive", "wavetable", "phase-distortion"]},
        {name: "Drums", variants: ["drum", "drums", "kit", "percussion", "drum-machine", "snare", "cajon", "darbuka"]},
        {name: "Sampler", variants: ["sampler", "sample", "soundfont", "general-midi"]},
        {name: "Keys", variants: ["keys", "piano", "upright", "organ", "pipe-organ"]},
        {name: "Mallets", variants: ["mallets", "xylophone", "vibraphone", "glockenspiel", "balafon", "bells", "chimes"]},
        {name: "Strings", variants: ["strings", "harp", "plucked", "guitar", "strum"]},
        {name: "Wind", variants: ["wind", "flute", "ocarina"]},
        {name: "Bass", variants: ["bass", "acid"]},
        {name: "Physical Modeling", variants: ["physical-modeling", "physical modeling", "physical modelling"]},
        {name: "Granular", variants: ["granular"]},
        {name: "Dynamics", variants: ["dynamics", "compressor", "limiter", "gate", "expander"]},
        {name: "EQ", variants: ["eq", "equalizer", "filter"]},
        {name: "Reverb", variants: ["reverb", "space", "spatial"]},
        {name: "Delay", variants: ["delay", "echo"]},
        {name: "Distortion", variants: ["distortion", "saturation", "wavefolder", "amp", "lo-fi", "lofi", "glitch", "tape"]},
        {name: "Modulation", variants: ["modulation", "chorus", "tremolo", "frequency-shifter"]},
        {name: "Pitch", variants: ["pitch", "transpose", "phase-vocoder"]},
        {name: "Vocal", variants: ["vocal"]},
        {name: "Stereo", variants: ["panning"]},
        {name: "Mastering", variants: ["mastering", "maximizer", "loudness"]},
        {name: "Analyzer", variants: ["analyzer"]},
        {name: "Arpeggiator", variants: ["arpeggiator"]},
        {name: "Groove", variants: ["groove", "shuffle", "timing", "humanize"]},
        {name: "Generative", variants: ["generative", "random", "sequencer"]},
        {name: "Velocity", variants: ["velocity"]},
        {name: "Utility", variants: ["utility", "routing", "parallel", "multiband", "layer"]}
    ]

    export const Untagged = "Untagged"

    export const matches = ({variants}: Tag, tags: ReadonlyArray<string>): boolean =>
        tags.some(tag => variants.includes(tag.toLowerCase()))

    // an empty name is All
    export const accepts = (name: string, tags: ReadonlyArray<string>): boolean => {
        if (name === Untagged) {return !List.some(tag => matches(tag, tags))}
        const tag = List.find(entry => entry.name === name)
        return isDefined(tag) ? matches(tag, tags) : true
    }
}
