import {
    AudioData,
    Chord,
    ClassicWaveform,
    dbToGain,
    FFT,
    gainToDb,
    Interpolation,
    midiToHz,
    Mixing,
    PPQN,
    ppqn,
    samples,
    seconds,
    bpm
} from "@opendaw/lib-dsp"
import {bipolar, float, int, Nullable, unitValue} from "@opendaw/lib-std"
import {AudioSendRouting, TransientPlayMode, VoicingMode} from "@opendaw/studio-enums"

export {PPQN, FFT, Chord, dbToGain, gainToDb, midiToHz, ClassicWaveform, VoicingMode, Mixing, TransientPlayMode, AudioSendRouting}
export type {ppqn, seconds, bpm, samples}

/**
 * A sample known to the studio. Obtain one via {@link Api.addSample} or {@link Api.listSamples}.
 * @group Samples
 */
export interface Sample {
    /** Unique id of the sample (uuid string) */
    readonly uuid: string
    /** Display name */
    readonly name: string
    /** Length in seconds */
    readonly duration: seconds
    /** Detected or assigned tempo (0 = unknown, plays in seconds when placed on the timeline) */
    readonly bpm: number
    /** Sample rate in Hz */
    readonly sample_rate: number
}

/**
 * Reference to a soundfont (.sf2) file known to the studio
 * @group Samples
 */
export interface SoundfontFile {
    /** Unique id of the file (uuid string) */
    readonly uuid: string
    /** Display name */
    readonly name: string
}

/**
 * Recursive partial used for construction props. Functions and read-only references are ignored.
 * @internal
 */
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends (...args: never[]) => unknown
        ? never
        : T[K] extends ReadonlyArray<infer E>
            ? ReadonlyArray<DeepPartial<E>>
            : T[K] extends object
                ? DeepPartial<T[K]>
                : T[K]
}

/** @internal building block of {@link ParameterPath} */
export type Primitive = number | boolean
/** @internal building block of {@link ParameterPath} */
export type Reference = { readonly uuid: string }
/** @internal building block of {@link ParameterPath} */
export type Shallower = [never, 0, 1, 2]

/**
 * All automatable parameter paths of an object, e.g. `"cutoff"`, `"lfo.rate"`, `"oscillators.0.volume"`.
 * Used by {@link AudioUnit.addValueTrack} and {@link Modulator.assign}. The editor completes valid paths.
 * @internal
 */
export type ParameterPath<T> = ParameterPathAt<T, 3>

/** @internal building block of {@link ParameterPath} */
export type ParameterPathAt<T, D extends number> = D extends 0 ? never : {
    [K in keyof T & string]: T[K] extends (...args: never[]) => unknown
        ? never
        : T[K] extends Reference
            ? never
            : T[K] extends Primitive
                ? K
                : T[K] extends ReadonlyArray<infer E>
                    ? E extends Primitive
                        ? `${K}.${number}`
                        : E extends Reference ? never : `${K}.${number}.${ParameterPathAt<E, Shallower[D]>}`
                    : T[K] extends object
                        ? `${K}.${ParameterPathAt<T[K], Shallower[D]>}`
                        : never
}[keyof T & string]

// ---------------------------------------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------------------------------------

/**
 * A send tap from a unit's channel strip to an aux or group bus
 * @group Sends
 */
export interface Send {
    /** Unique id */
    readonly uuid: string
    /** The unit this send originates from */
    readonly audioUnit: AnyAudioUnit
    /** The bus receiving the signal */
    readonly target: AuxAudioUnit | GroupAudioUnit
    /** Send amount in dB (-inf to 0) */
    amount: number
    /** Pan position (-1.0 = left, 0.0 = center, 1.0 = right) */
    pan: bipolar
    /** Pre-fader or post-fader tap */
    mode: "pre" | "post"
    /** Order in the send list */
    readonly index: int
    /** Remove this send */
    remove(): void
}

/**
 * Units that can send their signal to buses
 * @group Sends
 */
export interface Sendable {
    /** All sends of this unit ordered by index */
    readonly sends: ReadonlyArray<Send>
    /**
     * Add a send to an auxiliary or group unit
     * @param target - The destination unit
     * @param props - Send configuration ({@link Send})
     * @example
     * ```ts
     * const reverb = project.addAuxUnit({label: "Reverb"})
     * reverb.addAudioEffect("Reverb", {decay: 0.7})
     * synth.addSend(reverb, {amount: -12})
     * ```
     */
    addSend(target: AuxAudioUnit | GroupAudioUnit, props?: Partial<Pick<Send, "amount" | "pan" | "mode">>): Send
}

// ---------------------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------------------

/**
 * Common surface of instruments and effects
 * @group Devices
 */
export interface Device {
    /** Unique id */
    readonly uuid: string
    /** Custom label */
    label: string
    /** Enable or bypass the device */
    enabled: boolean
    /** Collapse the device editor in the studio */
    minimized: boolean
    /** Remove this device from its host */
    remove(): void
}

/**
 * A MIDI or audio effect sitting in a chain
 * @group Devices
 */
export interface Effect extends Device {
    /** Position in the effect chain (0 = first) */
    readonly index: int
    /** Move this effect to another position in its chain */
    move(index: int): void
}

/**
 * Effect processing notes before they reach the instrument
 * @group Devices
 */
export interface MIDIEffect extends Effect {
    /** Effect type identifier */
    readonly key: keyof MIDIEffects
    /** The audio unit this effect belongs to */
    readonly audioUnit: AnyAudioUnit
}

/**
 * Effect processing the audio signal after the instrument
 * @group Devices
 */
export interface AudioEffect extends Effect {
    /** Effect type identifier */
    readonly key: keyof AudioEffects
    /** The audio unit this effect belongs to */
    readonly audioUnit: AnyAudioUnit
}

/**
 * Anything the studio can tap as a sidechain source: a unit's channel strip, an instrument, an effect or a Playfield slot
 * @group Devices
 */
export type SideChainSource = AnyAudioUnit | AnyInstrument | AnyAudioEffect | PlayfieldSlot | AudioEffectCompositeEntry

/**
 * Effects that can listen to an external detection source
 * @group Devices
 */
export interface SideChainable {
    /** External detection source (null = the effect listens to its own input) */
    sideChain: Nullable<SideChainSource>
}

// ---- MIDI effects

/**
 * Generates rhythmic note sequences from held chords
 * @group MIDI Effects
 */
export interface ArpeggioEffect extends MIDIEffect {
    /** Always "Arpeggio" */
    readonly key: "Arpeggio"
    /** Playback direction: 0 = Up, 1 = Down, 2 = UpDown (default 0) */
    mode: 0 | 1 | 2
    /** Octave range (1 to 5, default 1) */
    octaves: int
    /** Step rate index (0-16): 1/1, 1/2, 1/3, 1/4, 3/16, 1/6, 1/8, 3/32, 1/12, 1/16, 3/64, 1/24, 1/32, 1/48, 1/64, 1/96, 1/128 (default 9 = 1/16) */
    rate: int
    /** Note length relative to the step (0.0 to 2.0, default 1.0) */
    gate: float
    /** Repeats per step (1 to 16, default 1) */
    repeat: int
    /** Velocity change per repeat (-1.0 to 1.0, default 0.0) */
    velocity: bipolar
}

/**
 * Shifts the pitch of incoming notes
 * @group MIDI Effects
 */
export interface PitchEffect extends MIDIEffect {
    /** Always "Pitch" */
    readonly key: "Pitch"
    /** Octave shift (-7 to 7, default 0) */
    octaves: int
    /** Semitone shift (-36 to 36, default 0) */
    semiTones: int
    /** Cent shift (-50 to 50, default 0) */
    cents: float
}

/**
 * Reshapes note velocities
 * @group MIDI Effects
 */
export interface VelocityEffect extends MIDIEffect {
    /** Always "Velocity" */
    readonly key: "Velocity"
    /** Velocity all notes are pulled towards (0.0 to 1.0, default 0.5) */
    magnetPosition: unitValue
    /** Pull strength (0.0 to 1.0, default 0.0) */
    magnetStrength: unitValue
    /** Random seed (default 2048) */
    randomSeed: int
    /** Random amount (0.0 to 1.0, default 0.0) */
    randomAmount: unitValue
    /** Constant offset (-1.0 to 1.0, default 0.0) */
    offset: bipolar
    /** Dry/wet mix (0.0 to 1.0, default 1.0) */
    mix: unitValue
}

/**
 * Shuffle / swing
 * @group MIDI Effects
 */
export interface ZeitgeistEffect extends MIDIEffect {
    /** Always "Zeitgeist" */
    readonly key: "Zeitgeist"
    /** The shuffle groove driving this effect */
    readonly groove: GrooveShuffle
}

/**
 * Scriptable MIDI effect. See {@link ScriptDevice}
 * @group MIDI Effects
 */
export interface SpielwerkEffect extends MIDIEffect, ScriptDevice {
    /** Always "Spielwerk" */
    readonly key: "Spielwerk"
}

/**
 * MIDI effect types by key. Use the keys with {@link MIDIEffectHost.addMIDIEffect}
 * @group MIDI Effects
 */
export interface MIDIEffects {
    /** {@link ArpeggioEffect} */
    "Arpeggio": ArpeggioEffect
    /** {@link PitchEffect} */
    "Pitch": PitchEffect
    /** {@link VelocityEffect} */
    "Velocity": VelocityEffect
    /** {@link ZeitgeistEffect} */
    "Zeitgeist": ZeitgeistEffect
    /** {@link SpielwerkEffect} */
    "Spielwerk": SpielwerkEffect
}

/**
 * Any MIDI effect
 * @group MIDI Effects
 */
export type AnyMIDIEffect = MIDIEffects[keyof MIDIEffects]

// ---- Audio effects

/**
 * Pitch correction towards a key and scale
 * @group Audio Effects
 */
export interface AutotuneEffect extends AudioEffect {
    /** Always "Autotune" */
    readonly key: "Autotune"
    /** Key (0-11): C, C#, D, D#, E, F, F#, G, G#, A, A#, B (default 0) */
    scaleKey: int
    /** Scale (0-7): Chromatic, Major, Minor, Major Pentatonic, Minor Pentatonic, Blues, Dorian, Mixolydian (default 1) */
    scale: int
    /** Correction amount (0.0 to 1.0, default 1.0) */
    amount: unitValue
    /** Retune speed (0.0 to 1.0, default 0.5) */
    retune: unitValue
    /** Pitch shift in semitones (-12 to 12, default 0) */
    shift: float
    /** Smoothing (0.0 to 1.0, default 0.6) */
    smooth: unitValue
}

/**
 * Dynamic range compressor
 * @group Audio Effects
 */
export interface CompressorEffect extends AudioEffect, SideChainable {
    /** Always "Compressor" */
    readonly key: "Compressor"
    /** Look ahead detection (default false) */
    lookahead: boolean
    /** Automatic makeup gain (default true) */
    automakeup: boolean
    /** Program dependent attack (default false) */
    autoattack: boolean
    /** Program dependent release (default false) */
    autorelease: boolean
    /** Input gain in dB (-30 to 30, default 0) */
    inputGain: float
    /** Threshold in dB (-60 to 0, default -10) */
    threshold: float
    /** Ratio (1 to 24, default 2) */
    ratio: float
    /** Knee in dB (0 to 24, default 0) */
    knee: float
    /** Attack in ms (0 to 100, default 0) */
    attack: float
    /** Release in ms (5 to 1500, default 25) */
    release: float
    /** Makeup gain in dB (-40 to 40, default 0) */
    makeup: float
    /** Dry/wet mix (0.0 to 1.0, default 1.0) */
    mix: unitValue
}

/**
 * Convolution reverb using an impulse response sample
 * @group Audio Effects
 */
export interface ConvolverEffect extends AudioEffect {
    /** Always "Convolver" */
    readonly key: "Convolver"
    /** Impulse response sample (null = none) */
    impulse: Nullable<Sample>
    /** Wet level in dB (default -3) */
    wet: float
    /** Dry level in dB (default 0) */
    dry: float
    /** Pre-delay in seconds (0.0 to 0.5, default 0.0) */
    preDelay: float
    /** Normalize the impulse response (default true) */
    normalize: boolean
    /** Play the impulse response reversed (default false) */
    reverse: boolean
}

/**
 * Bit crusher
 * @group Audio Effects
 */
export interface CrusherEffect extends AudioEffect {
    /** Always "Crusher" */
    readonly key: "Crusher"
    /** Sample rate reduction (0.0 to 1.0, default 0.0) */
    crush: unitValue
    /** Bit depth (1 to 16, default 16) */
    bits: int
    /** Boost in dB (0 to 24, default 0) */
    boost: float
    /** Dry/wet mix (0.001 to 1.0, default 1.0) */
    mix: float
}

/**
 * Dense algorithmic reverb based on Dattorro's design
 * @group Audio Effects
 */
export interface DattorroReverbEffect extends AudioEffect {
    /** Always "DattorroReverb" */
    readonly key: "DattorroReverb"
    /** Pre-delay in ms (0 to 1000, default 0) */
    preDelay: float
    /** Input bandwidth (0.0 to 1.0, default 0.9999) */
    bandwidth: unitValue
    /** Input diffusion 1 (0.0 to 1.0, default 0.75) */
    inputDiffusion1: unitValue
    /** Input diffusion 2 (0.0 to 1.0, default 0.625) */
    inputDiffusion2: unitValue
    /** Decay (0.0 to 1.0, default 0.75) */
    decay: unitValue
    /** Decay diffusion 1 (0.0 to 1.0, default 0.7) */
    decayDiffusion1: unitValue
    /** Decay diffusion 2 (0.0 to 1.0, default 0.5) */
    decayDiffusion2: unitValue
    /** High frequency damping (0.0 to 1.0, default 0.005) */
    damping: unitValue
    /** Modulation rate (0.0 to 1.0, default 0.5) */
    excursionRate: unitValue
    /** Modulation depth (0.0 to 1.0, default 0.7) */
    excursionDepth: unitValue
    /** Wet level in dB (default -6) */
    wet: float
    /** Dry level in dB (default 0) */
    dry: float
}

/**
 * Stereo delay with tempo-synced times
 * @group Audio Effects
 */
export interface DelayEffect extends AudioEffect {
    /** Always "Delay" */
    readonly key: "Delay"
    /** Delay time index (0-20): Off, 1/128, 1/96, 1/64, 1/48, 1/32, 1/24, 3/64, 1/16, 1/12, 3/32, 1/8, 1/6, 3/16, 1/4, 5/16, 1/3, 3/8, 7/16, 1/2, 1/1 (default 13 = 3/16) */
    delay: int
    /** Additional delay time in ms (0 to 1000, default 0) */
    delayMillis: float
    /** Pre-delay left, same index table as delay (default 8 = 1/16) */
    preSyncTimeLeft: int
    /** Pre-delay left in ms (0 to 1000, default 0) */
    preMillisTimeLeft: float
    /** Pre-delay right, same index table as delay (default 0 = Off) */
    preSyncTimeRight: int
    /** Pre-delay right in ms (0 to 1000, default 0) */
    preMillisTimeRight: float
    /** Feedback (0.0 to 1.0, default 0.5) */
    feedback: unitValue
    /** Cross-channel feedback (0.0 to 1.0, default 1.0) */
    cross: unitValue
    /** LFO speed in Hz (0.1 to 5, default 0.1) */
    lfoSpeed: float
    /** LFO depth in ms (0 to 50, default 0) */
    lfoDepth: float
    /** Feedback filter (-1.0 = lowpass, 0.0 = off, 1.0 = highpass, default 0.0) */
    filter: bipolar
    /** Wet level in dB (default -6) */
    wet: float
    /** Dry level in dB (default 0) */
    dry: float
}

/**
 * Wavefolder distortion
 * @group Audio Effects
 */
export interface FoldEffect extends AudioEffect {
    /** Always "Fold" */
    readonly key: "Fold"
    /** Drive in dB (0 to 30, default 0) */
    drive: float
    /** Oversampling (0 = off, 1 = 2x, 2 = 4x, default 0) */
    overSampling: 0 | 1 | 2
    /** Output volume in dB (-18 to 0, default 0) */
    volume: float
}

/**
 * Noise gate
 * @group Audio Effects
 */
export interface GateEffect extends AudioEffect, SideChainable {
    /** Always "Gate" */
    readonly key: "Gate"
    /** Threshold in dB (-80 to 0, default -6) */
    threshold: float
    /** Hysteresis in dB (0 to 24, default 0) */
    return: float
    /** Attack in ms (0 to 1000, default 1) */
    attack: float
    /** Hold in ms (0 to 500, default 50) */
    hold: float
    /** Release in ms (1 to 2000, default 100) */
    release: float
    /** Closed gain in dB (-72 to 0, default -72) */
    floor: float
    /** Invert (opens below threshold, default false) */
    inverse: boolean
}

/**
 * Brickwall limiter with automatic makeup gain
 * @group Audio Effects
 */
export interface MaximizerEffect extends AudioEffect {
    /** Always "Maximizer" */
    readonly key: "Maximizer"
    /** Look ahead (default true) */
    lookahead: boolean
    /** Threshold in dB (-24 to 0, default 0) */
    threshold: float
}

/**
 * Neural amp modeler (model is chosen in the studio)
 * @group Audio Effects
 */
export interface NeuralAmpEffect extends AudioEffect {
    /** Always "NeuralAmp" */
    readonly key: "NeuralAmp"
    /** Input gain in dB (default 0) */
    inputGain: float
    /** Output gain in dB (default 0) */
    outputGain: float
    /** Sum to mono before the model (default true) */
    mono: boolean
    /** Dry/wet mix (0.0 to 1.0, default 1.0) */
    mix: unitValue
}

/**
 * High/low-pass band of the Revamp equalizer
 * @group Effect Parts
 */
export interface RevampPass {
    /** Enable the band */
    enabled: boolean
    /** Frequency in Hz (20 to 20000) */
    frequency: float
    /** Filter order (0 to 3 = 6, 12, 18, 24 dB/oct) */
    order: 0 | 1 | 2 | 3
    /** Resonance (0.01 to 10) */
    q: float
}

/**
 * Shelf band of the Revamp equalizer
 * @group Effect Parts
 */
export interface RevampShelf {
    /** Enable the band */
    enabled: boolean
    /** Frequency in Hz (20 to 20000) */
    frequency: float
    /** Gain in dB (-24 to 24) */
    gain: float
}

/**
 * Bell band of the Revamp equalizer
 * @group Effect Parts
 */
export interface RevampBell {
    /** Enable the band */
    enabled: boolean
    /** Frequency in Hz (20 to 20000) */
    frequency: float
    /** Gain in dB (-24 to 24) */
    gain: float
    /** Resonance (0.01 to 10) */
    q: float
}

/**
 * Graphical equalizer with seven bands
 * @group Audio Effects
 */
export interface RevampEffect extends AudioEffect {
    /** Always "Revamp" */
    readonly key: "Revamp"
    /** High-pass band */
    readonly highPass: RevampPass
    /** Low shelf band */
    readonly lowShelf: RevampShelf
    /** Low bell band */
    readonly lowBell: RevampBell
    /** Mid bell band */
    readonly midBell: RevampBell
    /** High bell band */
    readonly highBell: RevampBell
    /** High shelf band */
    readonly highShelf: RevampShelf
    /** Low-pass band */
    readonly lowPass: RevampPass
}

/**
 * Free reverb
 * @group Audio Effects
 */
export interface ReverbEffect extends AudioEffect {
    /** Always "Reverb" */
    readonly key: "Reverb"
    /** Decay (0.0 to 1.0, default 0.5) */
    decay: unitValue
    /** Pre-delay in seconds (0.001 to 0.5, default 0.001) */
    preDelay: float
    /** Damping (0.0 to 1.0, default 0.5) */
    damp: unitValue
    /** Filter (-1.0 = lowpass, 0.0 = off, 1.0 = highpass, default 0.0) */
    filter: bipolar
    /** Wet level in dB (default -3) */
    wet: float
    /** Dry level in dB (default 0) */
    dry: float
}

/**
 * Stereo imaging tool
 * @group Audio Effects
 */
export interface StereoToolEffect extends AudioEffect {
    /** Always "StereoTool" */
    readonly key: "StereoTool"
    /** Volume in dB (-72 to 12, default 0) */
    volume: float
    /** Pan (-1.0 to 1.0, default 0.0) */
    panning: bipolar
    /** Stereo width (-1.0 = mono, 0.0 = unchanged, 1.0 = wide, default 0.0) */
    stereo: bipolar
    /** Invert left channel phase (default false) */
    invertL: boolean
    /** Invert right channel phase (default false) */
    invertR: boolean
    /** Swap channels (default false) */
    swap: boolean
    /** Panning law */
    panningMixing: Mixing
}

/**
 * Tremolo and auto-pan
 * @group Audio Effects
 */
export interface TidalEffect extends AudioEffect {
    /** Always "Tidal" */
    readonly key: "Tidal"
    /** Waveform slope (-1.0 to 1.0, default -0.25) */
    slope: bipolar
    /** Waveform symmetry (0.0 to 1.0, default 0.5) */
    symmetry: unitValue
    /** Rate in cycles per bar (0 to 16, default 3) */
    rate: float
    /** Depth (0.0 to 1.0, default 0.75) */
    depth: unitValue
    /** Phase offset in degrees (-180 to 180, default 0) */
    offset: float
    /** Phase offset between channels in degrees (-180 to 180, default 0; 180 = auto-pan) */
    channelOffset: float
}

/**
 * Classic analysis/synthesis vocoder
 * @group Audio Effects
 */
export interface VocoderEffect extends AudioEffect, SideChainable {
    /** Always "Vocoder" */
    readonly key: "Vocoder"
    /** Lowest carrier band in Hz (20 to 20000, default 100) */
    carrierMinFreq: float
    /** Highest carrier band in Hz (20 to 20000, default 12000) */
    carrierMaxFreq: float
    /** Lowest modulator band in Hz (20 to 20000, default 100) */
    modulatorMinFreq: float
    /** Highest modulator band in Hz (20 to 20000, default 12000) */
    modulatorMaxFreq: float
    /** Filter Q at the lowest band (1 to 60, default 20) */
    qStart: float
    /** Filter Q at the highest band (1 to 60, default 2) */
    qEnd: float
    /** Envelope attack in ms (0.1 to 100, default 5) */
    envAttack: float
    /** Envelope release in ms (1 to 1000, default 30) */
    envRelease: float
    /** Output gain in dB (-20 to 20, default 0) */
    gain: float
    /** Dry/wet mix (0.0 to 1.0, default 1.0) */
    mix: unitValue
    /** Number of bands (8, 12 or 16, default 16) */
    bandCount: 8 | 12 | 16
    /** Modulator source when no sidechain is set (default "noise-pink") */
    modulatorSource: "noise-pink" | "noise-white" | "input"
}

/**
 * Nonlinear waveshaping distortion
 * @group Audio Effects
 */
export interface WaveshaperEffect extends AudioEffect {
    /** Always "Waveshaper" */
    readonly key: "Waveshaper"
    /** Transfer function preset name or custom equation (default "hardclip") */
    equation: string
    /** Input gain in dB (0 to 40, default 0) */
    inputGain: float
    /** Output gain in dB (-24 to 24, default 0) */
    outputGain: float
    /** Dry/wet mix (0.0 to 1.0, default 1.0) */
    mix: unitValue
}

/**
 * Scriptable audio effect. See {@link ScriptDevice}
 * @group Audio Effects
 */
export interface WerkstattEffect extends AudioEffect, ScriptDevice {
    /** Always "Werkstatt" */
    readonly key: "Werkstatt"
}

/**
 * One entry (layer) of a parallel effect composite hosting its own effect chain
 * @group Effect Parts
 */
export interface AudioEffectCompositeEntry extends AudioEffectHost {
    /** Unique id */
    readonly uuid: string
    /** The composite this entry belongs to */
    readonly composite: AudioEffectCompositeEffect | StereoSplitEffect | FrequencySplitEffect
    /** Custom label */
    label: string
    /** Position in the composite */
    readonly index: int
    /** Entry gain in dB (default 0) */
    gain: float
    /** Mute the entry */
    mute: boolean
    /** Solo the entry */
    solo: boolean
    /** Pan (-1.0 to 1.0, default 0.0) */
    pan: bipolar
    /** Remove the entry (only possible on {@link AudioEffectCompositeEffect}) */
    remove(): void
}

/**
 * Runs several effect chains in parallel and mixes them back
 * @group Audio Effects
 */
export interface AudioEffectCompositeEffect extends AudioEffect {
    /** Always "Composite" */
    readonly key: "Composite"
    /** Dry level in dB (default -inf) */
    dry: float
    /** Wet level in dB (default 0) */
    wet: float
    /** All entries ordered by index */
    readonly entries: ReadonlyArray<AudioEffectCompositeEntry>
    /** Add a parallel entry */
    addEntry(props?: Partial<Pick<AudioEffectCompositeEntry, "label" | "gain" | "mute" | "solo" | "pan">>): AudioEffectCompositeEntry
}

/**
 * Processes left and right channels through their own chains (entries are fixed: 0 = left, 1 = right)
 * @group Audio Effects
 */
export interface StereoSplitEffect extends AudioEffect {
    /** Always "StereoSplit" */
    readonly key: "StereoSplit"
    /** Dry level in dB (default -inf) */
    dry: float
    /** Wet level in dB (default 0) */
    wet: float
    /** Fixed entries: [left, right] */
    readonly entries: ReadonlyArray<AudioEffectCompositeEntry>
}

/**
 * Splits the signal into four frequency bands, each with its own chain (Low, Low Mid, High Mid, High)
 * @group Audio Effects
 */
export interface FrequencySplitEffect extends AudioEffect {
    /** Always "FrequencySplit" */
    readonly key: "FrequencySplit"
    /** Dry level in dB (default -inf) */
    dry: float
    /** Wet level in dB (default 0) */
    wet: float
    /** Crossover Low / Low Mid in Hz (20 to 20000, default 200) */
    crossover1: float
    /** Crossover Low Mid / High Mid in Hz (20 to 20000, default 1000) */
    crossover2: float
    /** Crossover High Mid / High in Hz (20 to 20000, default 5000) */
    crossover3: float
    /** Fixed entries: [Low, Low Mid, High Mid, High] */
    readonly entries: ReadonlyArray<AudioEffectCompositeEntry>
}

/**
 * Audio effect types by key. Use the keys with {@link AudioEffectHost.addAudioEffect}
 * @group Audio Effects
 */
export interface AudioEffects {
    /** {@link AutotuneEffect} */
    "Autotune": AutotuneEffect
    /** {@link CompressorEffect} */
    "Compressor": CompressorEffect
    /** {@link ConvolverEffect} */
    "Convolver": ConvolverEffect
    /** {@link CrusherEffect} */
    "Crusher": CrusherEffect
    /** {@link DattorroReverbEffect} */
    "DattorroReverb": DattorroReverbEffect
    /** {@link DelayEffect} */
    "Delay": DelayEffect
    /** {@link FoldEffect} */
    "Fold": FoldEffect
    /** {@link GateEffect} */
    "Gate": GateEffect
    /** {@link MaximizerEffect} */
    "Maximizer": MaximizerEffect
    /** {@link NeuralAmpEffect} */
    "NeuralAmp": NeuralAmpEffect
    /** {@link RevampEffect} */
    "Revamp": RevampEffect
    /** {@link ReverbEffect} */
    "Reverb": ReverbEffect
    /** {@link StereoToolEffect} */
    "StereoTool": StereoToolEffect
    /** {@link TidalEffect} */
    "Tidal": TidalEffect
    /** {@link VocoderEffect} */
    "Vocoder": VocoderEffect
    /** {@link WaveshaperEffect} */
    "Waveshaper": WaveshaperEffect
    /** {@link WerkstattEffect} */
    "Werkstatt": WerkstattEffect
    /** {@link AudioEffectCompositeEffect} */
    "Composite": AudioEffectCompositeEffect
    /** {@link StereoSplitEffect} */
    "StereoSplit": StereoSplitEffect
    /** {@link FrequencySplitEffect} */
    "FrequencySplit": FrequencySplitEffect
}

/**
 * Any audio effect
 * @group Audio Effects
 */
export type AnyAudioEffect = AudioEffects[keyof AudioEffects]

// ---- Effect hosts

/**
 * Anything with a MIDI effect chain (units and Playfield slots)
 * @group Devices
 */
export interface MIDIEffectHost {
    /** MIDI effects ordered by index */
    readonly midiEffects: ReadonlyArray<AnyMIDIEffect>
    /**
     * Add a MIDI effect
     * @param key - Effect type
     * @param props - Initial parameter values
     * @param index - Insert position (default: end of chain)
     * @example
     * ```ts
     * synth.addMIDIEffect("Arpeggio", {rate: 9, octaves: 2})
     * ```
     */
    addMIDIEffect<K extends keyof MIDIEffects>(key: K, props?: DeepPartial<MIDIEffects[K]>, index?: int): MIDIEffects[K]
}

/**
 * Anything with an audio effect chain (units, Playfield slots, composite entries)
 * @group Devices
 */
export interface AudioEffectHost {
    /** Audio effects ordered by index */
    readonly audioEffects: ReadonlyArray<AnyAudioEffect>
    /**
     * Add an audio effect
     * @param key - Effect type
     * @param props - Initial parameter values
     * @param index - Insert position (default: end of chain)
     * @example
     * ```ts
     * synth.addAudioEffect("Delay", {delay: 13, feedback: 0.4, wet: -9})
     * const composite = synth.addAudioEffect("Composite")
     * composite.addEntry({label: "Crushed"}).addAudioEffect("Crusher", {bits: 8})
     * ```
     */
    addAudioEffect<K extends keyof AudioEffects>(key: K, props?: DeepPartial<AudioEffects[K]>, index?: int): AudioEffects[K]
}

// ---- Script devices (Werkstatt, Apparat, Spielwerk)

/**
 * A `// @param` declared by a script
 * @group Script Devices
 */
export interface ScriptParameter {
    /** Parameter name as declared in the script */
    readonly label: string
    /** Declaration order */
    readonly index: int
    /** Current value (in the declared range) */
    value: float
    /** Default value from the declaration */
    readonly defaultValue: float
}

/**
 * A `// @sample` declared by a script
 * @group Script Devices
 */
export interface ScriptSample {
    /** Sample slot name as declared in the script */
    readonly label: string
    /** Declaration order */
    readonly index: int
    /** Assigned sample (null = none) */
    sample: Nullable<Sample>
}

/**
 * Common surface of the scriptable devices Werkstatt, Apparat and Spielwerk
 * @group Script Devices
 */
export interface ScriptDevice {
    /** The script source. Setting it re-declares the parameters and samples from its `// @param` / `// @sample` lines */
    code: string
    /** Declared parameters */
    readonly parameters: ReadonlyArray<ScriptParameter>
    /** Declared sample slots */
    readonly samples: ReadonlyArray<ScriptSample>
    /** Find a parameter by its declared name */
    parameter(label: string): ScriptParameter
    /** Find a sample slot by its declared name */
    sample(label: string): ScriptSample
}

// ---- Instruments

/**
 * The sound source of an instrument unit
 * @group Devices
 */
export interface Instrument extends Device {
    /** Instrument type identifier */
    readonly key: keyof Instruments
    /** The audio unit this instrument belongs to */
    readonly audioUnit: InstrumentAudioUnit
    /** Icon name (see IconSymbol) */
    icon: string
    /** Removes the whole audio unit. Use {@link InstrumentAudioUnit.setInstrument} to swap the instrument */
    remove(): void
}

/**
 * Vaporisateur oscillator
 * @group Instrument Parts
 */
export interface VaporisateurOscillator {
    /** Waveform */
    waveform: ClassicWaveform
    /** Volume in dB (osc 1 default -6, osc 2 default -inf) */
    volume: float
    /** Octave offset (-3 to 3, default 0) */
    octave: int
    /** Fine-tuning in cents (-1200 to 1200, default 0) */
    tune: float
}

/**
 * Vaporisateur LFO
 * @group Instrument Parts
 */
export interface VaporisateurLFO {
    /** Waveform */
    waveform: ClassicWaveform
    /** Rate in Hz (0.0001 to 30, default 1.0) */
    rate: float
    /** Sync the rate to the tempo (default false) */
    sync: boolean
    /** Modulation amount to pitch (-1.0 to 1.0, default 0.0) */
    targetTune: bipolar
    /** Modulation amount to filter cutoff (-1.0 to 1.0, default 0.0) */
    targetCutoff: bipolar
    /** Modulation amount to volume (-1.0 to 1.0, default 0.0) */
    targetVolume: bipolar
}

/**
 * Vaporisateur noise generator
 * @group Instrument Parts
 */
export interface VaporisateurNoise {
    /** Attack in seconds (0.001 to 5.0) */
    attack: float
    /** Hold in seconds (0.001 to 5.0) */
    hold: float
    /** Release in seconds (0.001 to 5.0) */
    release: float
    /** Volume in dB (default -inf) */
    volume: float
}

/**
 * Classic subtractive synthesizer
 * @group Instruments
 */
export interface Vaporisateur extends Instrument {
    /** Always "Vaporisateur" */
    readonly key: "Vaporisateur"
    /** Filter cutoff in Hz (20 to 20000, default 8000) */
    cutoff: float
    /** Filter resonance (0.01 to 10, default 0.1) */
    resonance: float
    /** Filter order (1 to 4 poles, default 1) */
    filterOrder: 1 | 2 | 3 | 4
    /** Filter envelope amount (-1.0 to 1.0, default 0.0) */
    filterEnvelope: bipolar
    /** Filter keyboard tracking (-1.0 to 1.0, default 0.0) */
    filterKeyboard: bipolar
    /** Envelope attack in seconds (0.001 to 5.0, default 0.005) */
    attack: float
    /** Envelope decay in seconds (0.001 to 5.0, default 0.1) */
    decay: float
    /** Envelope sustain level (0.0 to 1.0, default 0.5) */
    sustain: unitValue
    /** Envelope release in seconds (0.001 to 5.0, default 0.5) */
    release: float
    /** Monophonic or polyphonic */
    voicingMode: VoicingMode
    /** Glide time (0.0 to 1.0, default 0.0) */
    glideTime: unitValue
    /** Unison voices (1, 3 or 5, default 1) */
    unisonCount: 1 | 3 | 5
    /** Unison detune in cents (1 to 1200, default 30) */
    unisonDetune: float
    /** Unison stereo spread (0.0 to 1.0, default 1.0) */
    unisonStereo: unitValue
    /** The LFO */
    readonly lfo: VaporisateurLFO
    /** Two oscillators */
    readonly oscillators: ReadonlyArray<VaporisateurOscillator>
    /** The noise generator */
    readonly noise: VaporisateurNoise
}

/**
 * One slot (pad) of the Playfield drum machine
 * @group Instrument Parts
 */
export interface PlayfieldSlot extends MIDIEffectHost, AudioEffectHost {
    /** Unique id */
    readonly uuid: string
    /** The Playfield this slot belongs to */
    readonly playfield: Playfield
    /** The sample played by this slot */
    readonly sample: Sample
    /** MIDI note triggering this slot (0 to 127) */
    note: int
    /** Icon name */
    icon: string
    /** Enable the slot */
    enabled: boolean
    /** Collapse the slot editor */
    minimized: boolean
    /** Mute the slot */
    mute: boolean
    /** Solo the slot */
    solo: boolean
    /** Exclusive: a new hit stops any other exclusive slot (hi-hat choke) */
    exclude: boolean
    /** Polyphonic playback (overlapping hits) */
    polyphone: boolean
    /** Gate mode: 0 = Off (play to end), 1 = On (stop on note-off), 2 = Loop */
    gate: 0 | 1 | 2
    /** Pitch in cents (-1200 to 1200, default 0) */
    pitch: float
    /** Sample start (0.0 to 1.0, default 0.0) */
    sampleStart: unitValue
    /** Sample end (0.0 to 1.0, default 1.0) */
    sampleEnd: unitValue
    /** Attack in seconds (0.001 to 5.0, default 0.001) */
    attack: float
    /** Release in seconds (0.001 to 5.0, default 0.02) */
    release: float
    /** Volume in dB (default 0) */
    volume: float
    /** Pan (-1.0 to 1.0, default 0.0) */
    panning: bipolar
    /** Remove the slot */
    remove(): void
}

/**
 * Drum machine playing one sample per note
 * @group Instruments
 */
export interface Playfield extends Instrument {
    /** Always "Playfield" */
    readonly key: "Playfield"
    /** All slots ordered by note */
    readonly slots: ReadonlyArray<PlayfieldSlot>
    /** Slot at the given note (null = empty) */
    slot(note: int): Nullable<PlayfieldSlot>
    /**
     * Assign a sample to a note. Replaces an existing slot at that note.
     * @param sample - The sample to play
     * @param props - Slot settings (`note` defaults to the next free note starting at 60)
     * @example
     * ```ts
     * const samples = await openDAW.listSamples()
     * const drums = project.addInstrumentUnit("Playfield", {label: "Drums"})
     * drums.instrument.addSample(samples[0], {note: 36})
     * ```
     */
    addSample(sample: Sample, props?: Partial<Omit<PlayfieldSlot, "uuid" | "playfield" | "sample" | "midiEffects" | "audioEffects" | "addMIDIEffect" | "addAudioEffect" | "remove">>): PlayfieldSlot
}

/**
 * Minimal sampler
 * @group Instruments
 */
export interface Nano extends Instrument {
    /** Always "Nano" */
    readonly key: "Nano"
    /** The sample (null = none) */
    sample: Nullable<Sample>
    /** Volume in dB (default -3) */
    volume: float
    /** Release in seconds (0.001 to 8, default 0.1) */
    release: float
}

/**
 * Soundfont (.sf2) player
 * @group Instruments
 */
export interface Soundfont extends Instrument {
    /** Always "Soundfont" */
    readonly key: "Soundfont"
    /** The soundfont file (null = none) */
    file: Nullable<SoundfontFile>
    /** Preset index within the soundfont (0 to 65535) */
    presetIndex: int
}

/**
 * A MIDI CC parameter of the MIDI output device
 * @group Instrument Parts
 */
export interface MIDIOutputParameter {
    /** Unique id */
    readonly uuid: string
    /** Custom label */
    label: string
    /** MIDI controller number (0 to 127, default 64) */
    controller: int
    /** Value (0.0 to 1.0) */
    value: unitValue
    /** Remove the parameter */
    remove(): void
}

/**
 * Sends notes to an external MIDI device
 * @group Instruments
 */
export interface MIDIOutput extends Instrument {
    /** Always "MIDIOutput" */
    readonly key: "MIDIOutput"
    /** MIDI channel (0 to 15) */
    channel: int
    /** Automatable CC parameters */
    readonly parameters: ReadonlyArray<MIDIOutputParameter>
    /** Add a CC parameter */
    addParameter(props?: Partial<Pick<MIDIOutputParameter, "label" | "controller" | "value">>): MIDIOutputParameter
}

/**
 * Tape audio player (hosts audio tracks)
 * @group Instruments
 */
export interface Tape extends Instrument {
    /** Always "Tape" */
    readonly key: "Tape"
    /** Flutter (0.0 to 1.0, default 0.2) */
    flutter: unitValue
    /** Wow (0.0 to 1.0, default 0.05) */
    wow: unitValue
    /** Noise (0.0 to 1.0, default 0.02) */
    noise: unitValue
    /** Saturation (0.0 to 1.0, default 0.5) */
    saturation: unitValue
}

/**
 * Neon vibrato
 * @group Instrument Parts
 */
export interface NeonVibrato {
    /** Waveform: 0 = Triangle, 1 = Saw Up, 2 = Saw Down, 3 = Square */
    wave: 0 | 1 | 2 | 3
    /** Delay (0 to 99) */
    delay: float
    /** Rate (0 to 99) */
    rate: float
    /** Depth (0 to 99) */
    depth: float
}

/**
 * One of the two Neon oscillator lines
 * @group Instrument Parts
 */
export interface NeonLine {
    /** First waveform (0-7): Saw, Square, Pulse, Double Sine, Saw-Pulse, Resonance Saw, Resonance Triangle, Resonance Trapezoid */
    wave1: int
    /** Second waveform (0 = off, 1-8 = the waves above) */
    wave2: int
    /** DCW key follow (0 to 9) */
    dcwKeyFollow: float
    /** DCA key follow (0 to 9) */
    dcaKeyFollow: float
}

/**
 * One 8-stage Neon envelope (rates and levels in the CZ 0-99 domain)
 * @group Instrument Parts
 */
export interface NeonEnvelope {
    /** Rate of stage 1 (0 to 99) */
    rate1: float
    /** Rate of stage 2 (0 to 99) */
    rate2: float
    /** Rate of stage 3 (0 to 99) */
    rate3: float
    /** Rate of stage 4 (0 to 99) */
    rate4: float
    /** Rate of stage 5 (0 to 99) */
    rate5: float
    /** Rate of stage 6 (0 to 99) */
    rate6: float
    /** Rate of stage 7 (0 to 99) */
    rate7: float
    /** Rate of stage 8 (0 to 99) */
    rate8: float
    /** Level of stage 1 (0 to 99) */
    level1: float
    /** Level of stage 2 (0 to 99) */
    level2: float
    /** Level of stage 3 (0 to 99) */
    level3: float
    /** Level of stage 4 (0 to 99) */
    level4: float
    /** Level of stage 5 (0 to 99) */
    level5: float
    /** Level of stage 6 (0 to 99) */
    level6: float
    /** Level of stage 7 (0 to 99) */
    level7: float
    /** Level of stage 8 (0 to 99) */
    level8: float
    /** Sustain stage (1 to 8, 0 = none) */
    sustain: int
    /** End stage (1 to 8) */
    end: int
}

/**
 * CZ-style phase distortion synthesizer
 * @group Instruments
 */
export interface Neon extends Instrument {
    /** Always "Neon" */
    readonly key: "Neon"
    /** Line select (0-3): 1, 2, 1+1', 1+2' */
    lineSelect: 0 | 1 | 2 | 3
    /** Modulation (0-2): Off, Ring, Noise */
    modulation: 0 | 1 | 2
    /** Octave (-3 to 3) */
    octave: int
    /** Detune of the primed line in cents (-4800 to 4800) */
    detune: float
    /** Glide time (0.0 to 1.0) */
    glideTime: unitValue
    /** Master tune in cents (-1200 to 1200) */
    tune: float
    /** Monophonic or polyphonic */
    voicingMode: VoicingMode
    /** The vibrato */
    readonly vibrato: NeonVibrato
    /** Two lines */
    readonly lines: ReadonlyArray<NeonLine>
    /** Six envelopes in fixed order: line1 pitch, line1 DCW, line1 DCA, line2 pitch, line2 DCW, line2 DCA */
    readonly envelopes: ReadonlyArray<NeonEnvelope>
}

/**
 * One step of a Cubed pattern
 * @group Instrument Parts
 */
export interface CubedStep {
    /** MIDI note (0 to 127) */
    note: int
    /** Step plays */
    active: boolean
    /** Slide into the next step */
    slide: boolean
    /** Accent */
    accent: boolean
}

/**
 * One of the 16 Cubed patterns
 * @group Instrument Parts
 */
export interface CubedPattern {
    /** Number of steps played (1 to 64) */
    length: int
    /** 64 steps */
    readonly steps: ReadonlyArray<CubedStep>
    /** Replace the steps from the beginning and set the length */
    setSteps(steps: ReadonlyArray<Partial<CubedStep>>): void
}

/**
 * 303-style acid bassline synthesizer with a built-in sequencer
 * @group Instruments
 */
export interface Cubed extends Instrument {
    /** Always "Cubed" */
    readonly key: "Cubed"
    /** Tuning in cents (-1200 to 1200, default 0) */
    tuning: float
    /** Cutoff (0.0 to 1.0, default 0.0) */
    cutoff: unitValue
    /** Resonance (0.0 to 1.0, default 1.0) */
    resonance: unitValue
    /** Envelope modulation (0.0 to 1.0, default 1.0) */
    envMod: unitValue
    /** Decay (0.0 to 1.0, default 0.5) */
    decay: unitValue
    /** Accent (0.0 to 1.0, default 1.0) */
    accent: unitValue
    /** Volume in dB (default -12) */
    volume: float
    /** Waveform: 0 = saw, 1 = square */
    waveform: 0 | 1
    /** Active pattern (0 to 15) */
    patternIndex: int
    /** 16 patterns */
    readonly patterns: ReadonlyArray<CubedPattern>
}

/**
 * Scriptable instrument. See {@link ScriptDevice}
 * @group Instruments
 */
export interface Apparat extends Instrument, ScriptDevice {
    /** Always "Apparat" */
    readonly key: "Apparat"
}

/**
 * Instrument types by key. Use the keys with {@link Project.addInstrumentUnit}
 * @group Instruments
 */
export interface Instruments {
    /** {@link Vaporisateur} */
    "Vaporisateur": Vaporisateur
    /** {@link Playfield} */
    "Playfield": Playfield
    /** {@link Nano} */
    "Nano": Nano
    /** {@link Soundfont} */
    "Soundfont": Soundfont
    /** {@link MIDIOutput} */
    "MIDIOutput": MIDIOutput
    /** {@link Tape} */
    "Tape": Tape
    /** {@link Neon} */
    "Neon": Neon
    /** {@link Cubed} */
    "Cubed": Cubed
    /** {@link Apparat} */
    "Apparat": Apparat
}

/**
 * Any instrument
 * @group Instruments
 */
export type AnyInstrument = Instruments[keyof Instruments]

/**
 * Any instrument or effect
 * @group Devices
 */
export type AnyDevice = AnyInstrument | AnyMIDIEffect | AnyAudioEffect

/**
 * Anything with automatable parameters
 * @group Automation
 */
export type Automatable =
    | AnyDevice
    | AnyAudioUnit
    | Send
    | PlayfieldSlot
    | AudioEffectCompositeEntry
    | ScriptParameter
    | MIDIOutputParameter
    | GrooveShuffle
    | AnyModulator
    | Modulation

// ---------------------------------------------------------------------------------------------------------
// Audio units
// ---------------------------------------------------------------------------------------------------------

/**
 * The four unit kinds
 * @group Audio Units
 */
export type AudioUnitKind = "instrument" | "auxiliary" | "group" | "output"

/**
 * A channel in the mixer: devices, tracks, volume, pan and routing
 * @group Audio Units
 */
export interface AudioUnit extends MIDIEffectHost, AudioEffectHost {
    /** Unique id */
    readonly uuid: string
    /** Unit type identifier */
    readonly kind: AudioUnitKind
    /** Custom label */
    label: string
    /** Output routing (null = unplugged). Defaults to the primary output */
    output: Nullable<OutputAudioUnit | GroupAudioUnit | AuxAudioUnit>
    /** Volume in dB (-96 to 6, default 0) */
    volume: float
    /** Pan (-1.0 = left, 0.0 = center, 1.0 = right) */
    panning: bipolar
    /** Mute */
    mute: boolean
    /** Solo */
    solo: boolean
    /** Position in the project (instruments first, then aux, groups, output) */
    readonly index: int
    /** All tracks ordered by index */
    readonly tracks: ReadonlyArray<AnyTrack>
    /** Note tracks */
    readonly noteTracks: ReadonlyArray<NoteTrack>
    /** Audio tracks */
    readonly audioTracks: ReadonlyArray<AudioTrack>
    /** Automation tracks */
    readonly valueTracks: ReadonlyArray<ValueTrack>
    /** Add a note track (only meaningful for note instruments) */
    addNoteTrack(props?: Partial<Pick<Track, "enabled">>, index?: int): NoteTrack
    /** Add an audio track (only meaningful for audio instruments like Tape) */
    addAudioTrack(props?: Partial<Pick<Track, "enabled">>, index?: int): AudioTrack
    /**
     * Add an automation track for a parameter
     * @param target - Any automatable object (this unit, a device, a send, ...)
     * @param parameter - Parameter path, e.g. `"cutoff"` or `"lfo.rate"`
     * @example
     * ```ts
     * const lane = synth.addValueTrack(synth.instrument, "cutoff")
     * lane.addRegion({duration: PPQN.Bar * 4}).addEvents([
     *     {position: 0, value: 0.2},
     *     {position: PPQN.Bar * 4, value: 0.9}
     * ])
     * ```
     */
    addValueTrack<T extends Automatable>(target: T, parameter: ParameterPath<T>, props?: Partial<Pick<Track, "enabled">>, index?: int): ValueTrack
    /** The automation track controlling a parameter, if any */
    valueTrack<T extends Automatable>(target: T, parameter: ParameterPath<T>): Nullable<ValueTrack>
    /** Remove this unit including all its tracks and devices (the output cannot be removed) */
    remove(): void
}

/**
 * Unit hosting an instrument, created with {@link Project.addInstrumentUnit}
 * @group Audio Units
 */
export interface InstrumentAudioUnit<K extends keyof Instruments = keyof Instruments> extends AudioUnit, Sendable {
    /** Always "instrument" */
    readonly kind: "instrument"
    /** The instrument */
    readonly instrument: Instruments[K]
    /**
     * Replace the instrument with another type (keeps tracks and effects)
     * @example
     * ```ts
     * const nano = synth.setInstrument("Nano", {release: 0.5})
     * ```
     */
    setInstrument<N extends keyof Instruments>(key: N, props?: DeepPartial<Instruments[N]>): Instruments[N]
}

/**
 * Common surface of aux, group and output units
 * @group Audio Units
 */
export interface BusAudioUnit extends AudioUnit {
    /** Icon name (see IconSymbol) */
    icon: string
    /** CSS color of the bus */
    color: string
}

/**
 * Send effect bus, fed by {@link Sendable.addSend}
 * @group Audio Units
 */
export interface AuxAudioUnit extends BusAudioUnit, Sendable {
    /** Always "auxiliary" */
    readonly kind: "auxiliary"
}

/**
 * Group bus, fed by routing a unit's {@link AudioUnit.output} to it or by sends
 * @group Audio Units
 */
export interface GroupAudioUnit extends BusAudioUnit, Sendable {
    /** Always "group" */
    readonly kind: "group"
}

/**
 * The primary output. Exactly one per project, cannot be removed
 * @group Audio Units
 */
export interface OutputAudioUnit extends BusAudioUnit {
    /** Always "output" */
    readonly kind: "output"
}

/**
 * Any unit
 * @group Audio Units
 */
export type AnyAudioUnit = InstrumentAudioUnit | AuxAudioUnit | GroupAudioUnit | OutputAudioUnit

/**
 * Settings accepted when creating a unit
 * @group Audio Units
 */
export type AudioUnitProps = Partial<Pick<AudioUnit, "label" | "volume" | "panning" | "mute" | "solo" | "output">>
/**
 * Settings accepted when creating a bus unit
 * @group Audio Units
 */
export type BusAudioUnitProps = AudioUnitProps & Partial<Pick<BusAudioUnit, "icon" | "color">>

// ---------------------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------------------

/**
 * The three track types
 * @group Timeline
 */
export type TrackType = "notes" | "audio" | "value"

/**
 * Lane of a unit holding regions (arrangement) and clips (launcher)
 * @group Timeline
 */
export interface Track {
    /** Unique id */
    readonly uuid: string
    /** Track type */
    readonly type: TrackType
    /** The audio unit or modulator this track belongs to */
    readonly owner: AnyAudioUnit | AnyModulator
    /** The audio unit this track belongs to (null for modulator automation lanes) */
    readonly audioUnit: Nullable<AnyAudioUnit>
    /** Enable or disable the track */
    enabled: boolean
    /** Keep the track out of piano mode */
    excludePianoMode: boolean
    /** Position within the owner */
    readonly index: int
    /** Remove this track including its regions and clips */
    remove(): void
}

/**
 * Content placed on the arrangement timeline
 * @group Timeline
 */
export interface Region {
    /** Unique id */
    readonly uuid: string
    /** Start position in PPQN */
    position: ppqn
    /** Length in PPQN (seconds for non-synced audio regions) */
    duration: number
    /** End position (position + duration) */
    readonly complete: number
    /** Mute the region */
    mute: boolean
    /** Custom label */
    label: string
    /** Color hue (0 to 360) */
    hue: int
    /** Remove the region */
    remove(): void
}

/**
 * Region repeating its content every `loopDuration`
 * @group Timeline
 */
export interface LoopableRegion extends Region {
    /** Loop cycle length in PPQN (seconds for non-synced audio regions) */
    loopDuration: number
    /** Loop start offset in PPQN (seconds for non-synced audio regions) */
    loopOffset: number
}

/**
 * Clip launch settings
 * @group Timeline
 */
export interface ClipPlayback {
    /** Loop the clip (default true) */
    loop: boolean
    /** Play backwards */
    reverse: boolean
    /** Speed index */
    speed: int
    /** Launch quantisation index */
    quantise: int
    /** Trigger mode index */
    trigger: int
}

/**
 * Content in the clip launcher
 * @group Timeline
 */
export interface Clip {
    /** Unique id */
    readonly uuid: string
    /** Slot index in the clip launcher */
    index: int
    /** Length in PPQN (seconds for non-synced audio clips) */
    duration: number
    /** Mute the clip */
    mute: boolean
    /** Custom label */
    label: string
    /** Color hue (0 to 360) */
    hue: int
    /** Launch settings */
    readonly launch: ClipPlayback
    /** Remove the clip */
    remove(): void
}

/**
 * A single note
 * @group Notes
 */
export interface NoteEvent {
    /** Unique id */
    readonly uuid: string
    /** Start position in PPQN relative to the region or clip */
    position: ppqn
    /** Length in PPQN (at least 1) */
    duration: ppqn
    /** MIDI pitch (0 to 127, 60 = middle C) */
    pitch: int
    /** Velocity (0.0 to 1.0) */
    velocity: unitValue
    /** Fine-tuning in cents (-50 to 50) */
    cents: float
    /** Repeat count (1 to 128) */
    playCount: int
    /** Repeat timing curve (-1.0 to 1.0) */
    playCurve: bipolar
    /** Probability in percent (0 to 100) */
    chance: int
    /** Remove the note */
    remove(): void
}

/**
 * Settings accepted by {@link NoteEventOwner.addEvent}
 * @group Notes
 */
export type NoteEventProps = Partial<Pick<NoteEvent, "position" | "duration" | "pitch" | "velocity" | "cents" | "playCount" | "playCurve" | "chance">>

/**
 * Common surface of note regions and clips
 * @group Notes
 */
export interface NoteEventOwner {
    /** All notes sorted by position */
    readonly events: ReadonlyArray<NoteEvent>
    /** Add a note (defaults: position 0, duration 1/16, pitch 60, velocity 100/127) */
    addEvent(props?: NoteEventProps): NoteEvent
    /**
     * Add many notes at once
     * @example
     * ```ts
     * region.addEvents([60, 64, 67].map((pitch, index) => ({position: index * PPQN.Quarter, duration: PPQN.Quarter, pitch})))
     * ```
     */
    addEvents(events: ReadonlyArray<NoteEventProps>): ReadonlyArray<NoteEvent>
    /** Remove all notes */
    clearEvents(): void
}

/**
 * Region holding notes
 * @group Notes
 */
export interface NoteRegion extends LoopableRegion, NoteEventOwner {
    /** The note track this region belongs to */
    readonly track: NoteTrack
    /** Offset of the events in PPQN */
    eventOffset: ppqn
}

/**
 * Clip holding notes
 * @group Notes
 */
export interface NoteClip extends Clip, NoteEventOwner {
    /** The note track this clip belongs to */
    readonly track: NoteTrack
}

/**
 * Region props. Pass `mirror` to share the notes of another region (a linked copy).
 * @group Notes
 */
export type NoteRegionProps = Partial<Pick<NoteRegion, "position" | "duration" | "loopDuration" | "loopOffset" | "eventOffset" | "mute" | "label" | "hue">> & {
    /** Share the notes of another region or clip (linked copy) */
    mirror?: NoteRegion | NoteClip
}
/**
 * Clip props. Pass `mirror` to share the notes of another region or clip (a linked copy)
 * @group Notes
 */
export type NoteClipProps = Partial<Pick<NoteClip, "index" | "duration" | "mute" | "label" | "hue">> & {
    /** Launch settings */
    launch?: Partial<ClipPlayback>
    /** Share the notes of another region or clip (linked copy) */
    mirror?: NoteRegion | NoteClip
}

/**
 * Track holding note regions and clips
 * @group Notes
 */
export interface NoteTrack extends Track {
    /** Always "notes" */
    readonly type: "notes"
    /** All regions sorted by position */
    readonly regions: ReadonlyArray<NoteRegion>
    /** All clips sorted by slot index */
    readonly clips: ReadonlyArray<NoteClip>
    /**
     * Add a region (default duration one bar). Throws if it overlaps an existing region
     * @example
     * ```ts
     * const region = synth.noteTracks[0].addRegion({duration: PPQN.Bar * 2, loopDuration: PPQN.Bar})
     * region.addEvent({position: 0, duration: PPQN.Quarter, pitch: 60})
     * ```
     */
    addRegion(props?: NoteRegionProps): NoteRegion
    /** Add a clip (default: next free slot, one bar) */
    addClip(props?: NoteClipProps): NoteClip
}

/**
 * One automation point
 * @group Automation
 */
export interface ValueEvent {
    /** Unique id */
    readonly uuid: string
    /** Position in PPQN relative to the region or clip */
    position: ppqn
    /** Normalized parameter value (0.0 to 1.0) */
    value: unitValue
    /** Interpolation towards the next event */
    interpolation: Interpolation
    /** Remove the event */
    remove(): void
}

/**
 * Settings accepted by {@link ValueEventOwner.addEvent}
 * @group Automation
 */
export type ValueEventProps = Partial<Pick<ValueEvent, "position" | "value" | "interpolation">>

/**
 * Common surface of automation regions and clips
 * @group Automation
 */
export interface ValueEventOwner {
    /** All events sorted by position */
    readonly events: ReadonlyArray<ValueEvent>
    /** Add an automation point (defaults: position 0, value 0, linear). Two points at the same position form a step */
    addEvent(props?: ValueEventProps): ValueEvent
    /** Add many points at once */
    addEvents(events: ReadonlyArray<ValueEventProps>): ReadonlyArray<ValueEvent>
    /** Remove all points */
    clearEvents(): void
}

/**
 * Region holding automation points
 * @group Automation
 */
export interface ValueRegion extends LoopableRegion, ValueEventOwner {
    /** The automation track this region belongs to */
    readonly track: ValueTrack
}

/**
 * Clip holding automation points
 * @group Automation
 */
export interface ValueClip extends Clip, ValueEventOwner {
    /** The automation track this clip belongs to */
    readonly track: ValueTrack
}

/**
 * Region props. Pass `mirror` to share the points of another region or clip (a linked copy)
 * @group Automation
 */
export type ValueRegionProps = Partial<Pick<ValueRegion, "position" | "duration" | "loopDuration" | "loopOffset" | "mute" | "label" | "hue">> & {
    /** Share the points of another region or clip (linked copy) */
    mirror?: ValueRegion | ValueClip
}
/**
 * Clip props. Pass `mirror` to share the points of another region or clip (a linked copy)
 * @group Automation
 */
export type ValueClipProps = Partial<Pick<ValueClip, "index" | "duration" | "mute" | "label" | "hue">> & {
    /** Launch settings */
    launch?: Partial<ClipPlayback>
    /** Share the points of another region or clip (linked copy) */
    mirror?: ValueRegion | ValueClip
}

/**
 * Automation track bound to one parameter, created with {@link AudioUnit.addValueTrack}
 * @group Automation
 */
export interface ValueTrack extends Track {
    /** Always "value" */
    readonly type: "value"
    /** The object owning the automated parameter */
    readonly target: Automatable
    /** The automated parameter path */
    readonly parameter: string
    /** All regions sorted by position */
    readonly regions: ReadonlyArray<ValueRegion>
    /** All clips sorted by slot index */
    readonly clips: ReadonlyArray<ValueClip>
    /** Add a region (default duration one bar). Throws if it overlaps an existing region */
    addRegion(props?: ValueRegionProps): ValueRegion
    /** Add a clip (default: next free slot, one bar) */
    addClip(props?: ValueClipProps): ValueClip
}

/**
 * How audio follows the tempo:
 * - `"no-sync"`: plays at its original speed, durations are in seconds
 * - `"pitch"`: repitches to fit the tempo (classic sampler stretch)
 * - `"timestretch"`: transient based time-stretch keeping the pitch
 * - `"signalsmith"`: spectral time-stretch with independent transpose
 * @group Audio
 */
export type AudioPlayback = "no-sync" | "pitch" | "timestretch" | "signalsmith"

/**
 * Fade in/out of an audio region
 * @group Audio
 */
export interface AudioFading {
    /** Fade-in length in PPQN */
    in: number
    /** Fade-out length in PPQN */
    out: number
    /** Fade-in curve (0.0 to 1.0, default 0.75) */
    inSlope: unitValue
    /** Fade-out curve (0.0 to 1.0, default 0.25) */
    outSlope: unitValue
}

/**
 * Common surface of audio regions and clips
 * @group Audio
 */
export interface AudioContent {
    /** The sample */
    readonly sample: Sample
    /** Tempo following mode (fixed at creation) */
    readonly playback: AudioPlayback
    /** Gain in dB (default 0) */
    gain: float
    /** Waveform display offset in seconds */
    waveformOffset: seconds
    /** Time-stretch transient mode (only `"timestretch"`) */
    transientPlayMode: TransientPlayMode
    /** Playback rate (only `"timestretch"`, default 1.0) */
    playbackRate: float
    /** Transpose in semitones (only `"signalsmith"`, -24 to 24) */
    transpose: float
}

/**
 * Region playing a sample
 * @group Audio
 */
export interface AudioRegion extends LoopableRegion, AudioContent {
    /** The audio track this region belongs to */
    readonly track: AudioTrack
    /** Fade in and out */
    readonly fading: AudioFading
}

/**
 * Clip playing a sample
 * @group Audio
 */
export interface AudioClip extends Clip, AudioContent {
    /** The audio track this clip belongs to */
    readonly track: AudioTrack
}

/**
 * Settings accepted by {@link AudioTrack.addRegion}
 * @group Audio
 */
export type AudioRegionProps = Partial<Pick<AudioRegion, "position" | "duration" | "loopDuration" | "loopOffset" | "mute" | "label" | "hue" | "gain" | "waveformOffset" | "playback" | "transientPlayMode" | "playbackRate" | "transpose">> & {
    /** Fade in and out */
    fading?: Partial<AudioFading>
}
/**
 * Settings accepted by {@link AudioTrack.addClip}
 * @group Audio
 */
export type AudioClipProps = Partial<Pick<AudioClip, "index" | "duration" | "mute" | "label" | "hue" | "gain" | "waveformOffset" | "playback" | "transientPlayMode" | "playbackRate" | "transpose">> & {
    /** Launch settings */
    launch?: Partial<ClipPlayback>
}

/**
 * Track holding audio regions and clips (Tape units)
 * @group Audio
 */
export interface AudioTrack extends Track {
    /** Always "audio" */
    readonly type: "audio"
    /** All regions sorted by position */
    readonly regions: ReadonlyArray<AudioRegion>
    /** All clips sorted by slot index */
    readonly clips: ReadonlyArray<AudioClip>
    /**
     * Add an audio region. Default playback is `"pitch"` when the sample has a tempo, otherwise `"no-sync"`.
     * Default duration is the sample length. Throws if it overlaps an existing region
     * @example
     * ```ts
     * const tape = project.addInstrumentUnit("Tape", {label: "Loop"})
     * tape.audioTracks[0].addRegion(sample, {position: PPQN.Bar, playback: "timestretch"})
     * ```
     */
    addRegion(sample: Sample, props?: AudioRegionProps): AudioRegion
    /** Add an audio clip (default: next free slot) */
    addClip(sample: Sample, props?: AudioClipProps): AudioClip
}

/**
 * Any track
 * @group Timeline
 */
export type AnyTrack = NoteTrack | AudioTrack | ValueTrack
/**
 * Any region
 * @group Timeline
 */
export type AnyRegion = NoteRegion | AudioRegion | ValueRegion
/**
 * Any clip
 * @group Timeline
 */
export type AnyClip = NoteClip | AudioClip | ValueClip

// ---- Global timeline

/**
 * Arrangement marker
 * @group Timeline
 */
export interface Marker {
    /** Unique id */
    readonly uuid: string
    /** Position in PPQN */
    position: ppqn
    /** Label */
    label: string
    /** Color hue (0 to 360) */
    hue: int
    /** Play count before continuing (0 = infinite, 1 = normal) */
    plays: int
    /** Remove the marker */
    remove(): void
}

/**
 * Settings accepted by {@link Project.addMarker}
 * @group Timeline
 */
export type MarkerProps = Partial<Pick<Marker, "position" | "label" | "hue" | "plays">>

/**
 * A tempo change
 * @group Timeline
 */
export interface TempoEvent {
    /** Unique id */
    readonly uuid: string
    /** Position in PPQN */
    position: ppqn
    /** Tempo in bpm (30 to 1000) */
    bpm: number
    /** Interpolation towards the next event */
    interpolation: Interpolation
    /** Remove the event */
    remove(): void
}

/**
 * Settings accepted by {@link TempoTrack.addEvent}
 * @group Timeline
 */
export type TempoEventProps = Partial<Pick<TempoEvent, "position" | "bpm" | "interpolation">>

/**
 * Tempo automation of the project
 * @group Timeline
 */
export interface TempoTrack {
    /** Enable tempo automation */
    enabled: boolean
    /** Lower display bound in bpm */
    minBpm: int
    /** Upper display bound in bpm */
    maxBpm: int
    /** All events sorted by position */
    readonly events: ReadonlyArray<TempoEvent>
    /** Add a tempo change */
    addEvent(props?: TempoEventProps): TempoEvent
    /** Remove all events */
    clearEvents(): void
}

/**
 * A time signature change
 * @group Timeline
 */
export interface SignatureEvent {
    /** Unique id */
    readonly uuid: string
    /** Absolute position in PPQN (derived from the bars since the previous change) */
    readonly position: ppqn
    /** Bars since the previous signature change (at least 1) */
    relativePosition: int
    /** Beats per bar (1 to 31) */
    numerator: int
    /** Beat unit (power of two, 1 to 32) */
    denominator: int
    /** Order */
    readonly index: int
    /** Remove the event */
    remove(): void
}

/**
 * Time signature changes of the project
 * @group Timeline
 */
export interface SignatureTrack {
    /** Enable signature changes */
    enabled: boolean
    /** All events in order */
    readonly events: ReadonlyArray<SignatureEvent>
    /** Add a signature change at the bar closest to the position */
    addEvent(position: ppqn, numerator: int, denominator: int): SignatureEvent
    /** Remove all events */
    clearEvents(): void
}

/**
 * Transport loop range
 * @group Core
 */
export interface LoopArea {
    /** Loop enabled */
    enabled: boolean
    /** Loop start in PPQN */
    from: ppqn
    /** Loop end in PPQN */
    to: ppqn
}

/**
 * Beats per bar and beat unit
 * @group Core
 */
export interface TimeSignature {
    /** Beats per bar (1 to 31) */
    numerator: int
    /** Beat unit (power of two, 1 to 32) */
    denominator: int
}

/**
 * Global shuffle groove
 * @group Core
 */
export interface GrooveShuffle {
    /** Custom label */
    label: string
    /** Shuffle amount (0.0 to 1.0, default 0.6) */
    amount: unitValue
    /** Shuffle grid in PPQN (default 1/8) */
    duration: ppqn
}

/**
 * Descriptive project metadata
 * @group Core
 */
export interface ProjectMeta {
    /** Artist */
    artist: string
    /** Description */
    description: string
    /** Tags */
    tags: ReadonlyArray<string>
    /** Free text notes */
    notepad: string
}

// ---------------------------------------------------------------------------------------------------------
// Modulators
// ---------------------------------------------------------------------------------------------------------

/**
 * An assignment of a modulator to a parameter
 * @group Modulators
 */
export interface Modulation {
    /** Unique id */
    readonly uuid: string
    /** The modulator driving this assignment */
    readonly source: AnyModulator
    /** The object owning the modulated parameter */
    readonly target: Automatable
    /** The modulated parameter path */
    readonly parameter: string
    /** Modulation depth (-1.0 to 1.0) */
    depth: bipolar
    /** Enable the assignment */
    enabled: boolean
    /** Remove the assignment */
    remove(): void
}

/**
 * Common surface of all modulators, created with {@link Project.addModulator}
 * @group Modulators
 */
export interface Modulator {
    /** Unique id */
    readonly uuid: string
    /** Modulator type identifier */
    readonly kind: keyof Modulators
    /** Custom label */
    label: string
    /** Enable the modulator */
    enabled: boolean
    /** Order in the modulator list */
    readonly index: int
    /** Bipolar output (-1 to 1) instead of unipolar (0 to 1) (default true) */
    bipolar: boolean
    /** Output amount (0.0 to 1.0, default 1.0) */
    amount: unitValue
    /** All assignments */
    readonly modulations: ReadonlyArray<Modulation>
    /** Automation lanes of this modulator's own parameters and assignment depths */
    readonly valueTracks: ReadonlyArray<ValueTrack>
    /**
     * Add an automation lane for one of this modulator's parameters or an assignment depth
     * @param target - This modulator or one of its modulations
     * @param parameter - Parameter path, e.g. `"rateAbsolute"` or `"depth"`
     */
    addValueTrack<T extends AnyModulator | Modulation>(target: T, parameter: ParameterPath<T>, props?: Partial<Pick<Track, "enabled">>): ValueTrack
    /**
     * Assign this modulator to a parameter
     * @param target - Any modulatable object (a device, a unit, ...)
     * @param parameter - Parameter path, e.g. `"cutoff"`
     * @param depth - Modulation depth (-1.0 to 1.0, default 0.25)
     * @example
     * ```ts
     * const lfo = project.addModulator("LFO", {rateSync: 6})
     * lfo.assign(synth.instrument, "cutoff", 0.5)
     * ```
     */
    assign<T extends Automatable>(target: T, parameter: ParameterPath<T>, depth?: bipolar): Modulation
    /** Remove this modulator including its assignments */
    remove(): void
}

/**
 * Low frequency oscillator
 * @group Modulators
 */
export interface LfoModulator extends Modulator {
    /** Always "LFO" */
    readonly kind: "LFO"
    /** Shape (0-4): Sine, Triangle, Saw up, Saw down, Square */
    shape: 0 | 1 | 2 | 3 | 4
    /** Synced rate index (0 = free running, 1-12): 8 bars, 4 bars, 2 bars, 1 bar, 1/2, 1/4, 1/6, 1/8, 1/12, 1/16, 1/24, 1/32 (default 4) */
    rateSync: int
    /** Free running rate in Hz (0 to 10, used when rateSync is 0) */
    rateAbsolute: float
    /** Phase offset (0.0 to 1.0) */
    phase: unitValue
    /** Curve exponent (-1.0 to 1.0) */
    exponent: bipolar
}

/**
 * Step sequencer
 * @group Modulators
 */
export interface StepsModulator extends Modulator {
    /** Always "Steps" */
    readonly kind: "Steps"
    /** Number of steps (1 to 64, default 16) */
    count: int
    /** Synced step rate index (see {@link LfoModulator.rateSync}, default 10 = 1/16) */
    rateSync: int
    /** Free running rate in Hz (0 to 10, used when rateSync is 0) */
    rateAbsolute: float
    /** Phase offset (0.0 to 1.0) */
    phase: unitValue
    /** Smoothing between steps (0.0 to 1.0) */
    smooth: unitValue
    /** Direction (0-4): Forward, Backward, Ping-Pong, Alternate, Random */
    direction: 0 | 1 | 2 | 3 | 4
    /** 64 step values (0.0 to 1.0) */
    readonly steps: ReadonlyArray<unitValue>
    /** Replace the steps from the beginning and set the count */
    setSteps(values: ReadonlyArray<unitValue>): void
}

/**
 * Manual macro control
 * @group Modulators
 */
export interface MacroModulator extends Modulator {
    /** Always "Macro" */
    readonly kind: "Macro"
    /** Value (0.0 to 1.0, default 0.5) */
    value: unitValue
}

/**
 * Random generator
 * @group Modulators
 */
export interface RandomModulator extends Modulator {
    /** Always "Random" */
    readonly kind: "Random"
    /** Repeat after n values (0 = never, 1 to 64) */
    loop: int
    /** Synced rate index (see {@link LfoModulator.rateSync}, default 10 = 1/16) */
    rateSync: int
    /** Free running rate in Hz (0 to 10, used when rateSync is 0) */
    rateAbsolute: float
    /** Phase offset (0.0 to 1.0) */
    phase: unitValue
    /** Smoothing (0.0 to 1.0) */
    smooth: unitValue
    /** Random seed (0 to 999999) */
    seed: int
    /** Quantise to n levels (0 = continuous, 1 to 32) */
    levels: int
}

/**
 * Modulator types by kind. Use the kinds with {@link Project.addModulator}
 * @group Modulators
 */
export interface Modulators {
    /** {@link LfoModulator} */
    "LFO": LfoModulator
    /** {@link StepsModulator} */
    "Steps": StepsModulator
    /** {@link MacroModulator} */
    "Macro": MacroModulator
    /** {@link RandomModulator} */
    "Random": RandomModulator
}

/**
 * Any modulator
 * @group Modulators
 */
export type AnyModulator = Modulators[keyof Modulators]

// ---------------------------------------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------------------------------------

/**
 * A project under construction or the one open in the studio. Hand it back with {@link Project.openInStudio}
 * @group Core
 */
export interface Project {
    /** Project name */
    name: string
    /** Tempo in bpm (30 to 1000) */
    bpm: number
    /** Time signature. Assign an object or set its fields */
    timeSignature: TimeSignature
    /** Tuning reference in Hz (400 to 480, default 440) */
    baseFrequency: float
    /** Project length in PPQN */
    duration: ppqn
    /** Loop range */
    readonly loop: LoopArea
    /** Project metadata */
    readonly meta: ProjectMeta
    /** Global shuffle groove */
    readonly groove: GrooveShuffle
    /** Primary output unit */
    readonly output: OutputAudioUnit
    /** All units ordered by index */
    readonly audioUnits: ReadonlyArray<AnyAudioUnit>
    /** Instrument units */
    readonly instrumentUnits: ReadonlyArray<InstrumentAudioUnit>
    /** Auxiliary (send effect) units */
    readonly auxUnits: ReadonlyArray<AuxAudioUnit>
    /** Group (bus) units */
    readonly groupUnits: ReadonlyArray<GroupAudioUnit>
    /** Find a unit by its label */
    findAudioUnit(label: string): Nullable<AnyAudioUnit>
    /**
     * Add an instrument unit. It comes with one default track matching the instrument.
     * @param key - Instrument type
     * @param props - Unit settings
     * @param instrument - Initial instrument parameters
     * @example
     * ```ts
     * const synth = project.addInstrumentUnit("Vaporisateur", {label: "Lead", volume: -6}, {cutoff: 2400, resonance: 0.4})
     * ```
     */
    addInstrumentUnit<K extends keyof Instruments>(key: K, props?: AudioUnitProps, instrument?: DeepPartial<Instruments[K]>): InstrumentAudioUnit<K>
    /** Add an auxiliary (send effect) unit */
    addAuxUnit(props?: BusAudioUnitProps): AuxAudioUnit
    /** Add a group (bus) unit */
    addGroupUnit(props?: BusAudioUnitProps): GroupAudioUnit
    /** Timeline markers sorted by position */
    readonly markers: ReadonlyArray<Marker>
    /** Add a marker */
    addMarker(props?: MarkerProps): Marker
    /** Tempo automation */
    readonly tempoTrack: TempoTrack
    /** Time signature changes */
    readonly signatureTrack: SignatureTrack
    /** All modulators ordered by index */
    readonly modulators: ReadonlyArray<AnyModulator>
    /**
     * Add a modulator
     * @example
     * ```ts
     * const steps = project.addModulator("Steps", {count: 8, rateSync: 10})
     * steps.setSteps([1, 0, 0.5, 0, 1, 0, 0.5, 0.25])
     * ```
     */
    addModulator<K extends keyof Modulators>(kind: K, props?: DeepPartial<Modulators[K]>): Modulators[K]
    /** Open the project in the studio (replaces the current project). Throws if the project is invalid */
    openInStudio(): void
}

/**
 * The global `openDAW` object, entry point of every script
 * @group Core
 */
export interface Api {
    /**
     * Create a new empty project
     * @example
     * ```ts
     * const project = openDAW.newProject("Hello")
     * project.bpm = 120
     * project.openInStudio()
     * ```
     */
    newProject(name?: string): Project
    /** Whether a project is open in the studio */
    hasProject(): Promise<boolean>
    /**
     * Load the project currently open in the studio for modification. Call {@link Project.openInStudio} to apply. Throws if none is open
     * @example
     * ```ts
     * const project = await openDAW.getProject()
     * project.audioUnits.forEach(unit => unit.mute = false)
     * project.openInStudio()
     * ```
     */
    getProject(): Promise<Project>
    /** Show an info dialog in the studio and wait until it is closed */
    showInfo(headline: string, message: string): Promise<void>
    /**
     * Create a sample in the studio from raw audio data
     * @example
     * ```ts
     * const audio = AudioData.create(sampleRate, sampleRate, 1)
     * audio.frames[0].forEach((_, index) => audio.frames[0][index] = Math.sin(index * 440 / sampleRate * Math.PI * 2) * 0.5)
     * const sample = await openDAW.addSample(audio, "Sine")
     * ```
     */
    addSample(data: AudioData, name: string): Promise<Sample>
    /** All samples available in the studio (stock and user samples) */
    listSamples(): Promise<ReadonlyArray<Sample>>
}
