import {
    AudioData,
    Chord,
    ClassicWaveform,
    dbToGain,
    FFT,
    gainToDb,
    Interpolation,
    midiToHz,
    PPQN,
    ppqn
} from "@opendaw/lib-dsp"
import {bipolar, float, int, Nullable, Procedure, unitValue} from "@opendaw/lib-std"
import {Sample} from "@opendaw/studio-adapters"
import {VoicingMode} from "@opendaw/studio-enums"

export {PPQN, FFT, Chord, Sample, dbToGain, gainToDb, midiToHz, ClassicWaveform, VoicingMode}
export type {Procedure}

export enum AudioPlayback {NoWarp = 0, PitchStretch = 1, /* TODO TimeStretch*/}

export type Send = {
    /** Send amount in decibels */
    amount: number
    /** Pan position for the Send (-1.0 = left, 0.0 = center, 1.0 = right) */
    pan: bipolar
    /** Send routing mode (pre-fader or post-fader) */
    mode: "pre" | "post"
}

export interface Sendable {
    /**
     * Add a Send to an auxiliary or group unit
     * @param target - The destination unit for the Send
     * @param props - Send configuration ({@link Send})
     */
    addSend(target: AuxAudioUnit | GroupAudioUnit, props?: Partial<Send>): Send
    /** Remove an existing Send */
    removeSend(send: Send): void
}

export type AnyDevice =
    | MIDIEffects[keyof MIDIEffects]
    | AudioEffects[keyof AudioEffects]
    | Instruments[keyof Instruments]
    | AudioUnit

export interface Effect {
    /** Enable or bypass the effect */
    enabled: boolean
    /** Custom label for the effect */
    label: string
}

export interface AudioEffect extends Effect {
    /** Effect type identifier */
    readonly key: keyof AudioEffects
}

export interface DelayEffect extends AudioEffect {
    /** Delay time index (0-16): 1/1, 1/2, 1/3, 1/4, 3/16, 1/6, 1/8, 3/32, 1/12, 1/16, 3/64, 1/24, 1/32, 1/48, 1/64, 1/96, 1/128 note fractions */
    delay: number
    /** Feedback amount (0.0 to 1.0) */
    feedback: number
    /** Cross-feedback amount (0.0 to 1.0) */
    cross: number
    /** Filter cutoff frequency */
    filter: number
    /** Wet (processed) signal level (0.0 to 1.0) */
    wet: number
    /** Dry (original) signal level (0.0 to 1.0) */
    dry: number
}

export interface AudioEffects {
    "delay": DelayEffect
}

export interface MIDIEffect extends Effect {
    /** Effect type identifier */
    readonly key: keyof MIDIEffects
}

export interface PitchEffect extends MIDIEffect {
    /** Pitch shift in octaves */
    octaves: int
    /** Pitch shift in semitones */
    semiTones: int
    /** Fine pitch shift in cents (100 cents = 1 semitone) */
    cents: float
}

export interface MIDIEffects {
    "pitch": PitchEffect
}

export interface AudioUnit {
    /** Output routing destination, if unset it goes to primary output, if null, it remains unplugged */
    output?: Nullable<OutputAudioUnit | GroupAudioUnit>
    /** Volume in decibels (dB) */
    volume: number
    /** Pan position (-1.0 = full left, 0.0 = center, 1.0 = full right) */
    panning: bipolar
    /** Mute the audio unit */
    mute: boolean
    /** Solo the audio unit */
    solo: boolean
    /** Add an audio effect to the unit */
    addAudioEffect<T extends keyof AudioEffects>(type: T, props?: Partial<AudioEffects[T]>): AudioEffects[T]
    /** Add a MIDI effect to the unit */
    addMIDIEffect<T extends keyof MIDIEffects>(type: T, props?: Partial<MIDIEffects[T]>): MIDIEffects[T]
    /** Add a note track for MIDI events */
    addNoteTrack(props?: Partial<Pick<Track, "enabled">>): NoteTrack
    /** Add an audio track */
    addAudioTrack(props?: Partial<Pick<Track, "enabled">>): AudioTrack
    /** Add an automation track for parameter changes */
    addValueTrack<DEVICE extends AnyDevice, PARAMETER extends keyof DEVICE>(
        device: DEVICE, parameter: PARAMETER, props?: Partial<Pick<Track, "enabled">>): ValueTrack
}

export interface InstrumentAudioUnit extends AudioUnit, Sendable {
    /** Unit type identifier */
    readonly kind: "instrument"
    /** The instrument instance */
    readonly instrument: Instrument
    /** Change the instrument type */
    setInstrument(name: keyof Instruments): Instrument
}

export interface AuxAudioUnit extends AudioUnit, Sendable {
    /** Unit type identifier */
    readonly kind: "auxiliary"
    /** Custom label for the auxiliary unit */
    label: string
}

export interface GroupAudioUnit extends AudioUnit, Sendable {
    /** Unit type identifier */
    readonly kind: "group"
    /** Custom label for the group unit */
    label: string
}

export interface OutputAudioUnit extends AudioUnit {
    /** Unit type identifier */
    readonly kind: "output"
}

export interface Track {
    /** The audio unit this track belongs to */
    readonly audioUnit: AudioUnit
    /** Enable or disable the track */
    enabled: boolean
}

export interface Region {
    /** Start position in PPQN */
    position: ppqn
    /** Length in PPQN */
    duration: ppqn
    /** Mute the region */
    mute: boolean
    /** Custom label for the region */
    label: string
    /** Color hue (0-360) */
    hue: int
}

export interface LoopableRegion extends Region {
    /** Loop cycle length in PPQN */
    loopDuration: ppqn
    /** Loop start offset in PPQN */
    loopOffset: ppqn
}

export interface NoteEvent {
    /** Start position in PPQN */
    position: ppqn
    /** Note length in PPQN */
    duration: ppqn
    /** MIDI pitch (0-127, where 60 = middle C) */
    pitch: number
    /** Fine-tuning in cents (-100 to +100) */
    cents: number
    /** Note velocity (0.0 to 1.0) */
    velocity: number
}

export interface NoteRegion extends LoopableRegion {
    /** The note track this region belongs to */
    readonly track: NoteTrack
    /** Add a MIDI note event to the region */
    addEvent(props?: Partial<NoteEvent>): NoteEvent
    addEvents(events: Array<Partial<NoteEvent>>): void
}

export type NoteRegionProps = Partial<NoteRegion & { mirror: NoteRegion }>

export interface NoteTrack extends Track {
    /** Add a note region to the track */
    addRegion(props?: NoteRegionProps): NoteRegion
}

export interface AudioRegion extends LoopableRegion {
    /** The audio track this region belongs to */
    readonly track: AudioTrack

    /** NoSync is not dependent on the tempo. Pass seconds for duration, loopOffset and loopDuration! **/
    playback: AudioPlayback
}

export interface AudioTrack extends Track {
    /** Add an audio region to the track */
    addRegion(sample: Sample, props?: Partial<AudioRegion>): AudioRegion
}

export interface ValueEvent {
    /** Position in PPQN */
    position: ppqn
    /** Parameter value (0.0 to 1.0) */
    value: unitValue
    /** Interpolation curve type */
    interpolation: Interpolation
}

export interface ValueRegion extends LoopableRegion {
    /** The automation track this region belongs to */
    readonly track: ValueTrack
    /** Add an automation point to the region */
    addEvent(props?: Partial<ValueEvent>): ValueEvent
    addEvents(events: Array<Partial<ValueEvent>>): void
}

export type ValueRegionProps = Partial<ValueRegion & { mirror: ValueRegion }>

export interface ValueTrack extends Track {
    /** Add an automation region to the track */
    addRegion(props?: ValueRegionProps): ValueRegion
}

export interface Instrument {
    /** The audio unit this instrument belongs to */
    readonly audioUnit: InstrumentAudioUnit
}

export interface MIDIInstrument extends Instrument {}

export interface AudioInstrument extends Instrument {}

/** Vaporisateur oscillator configuration */
export interface VaporisateurOscillator {
    /** Waveform type (sine, triangle, saw, square) */
    waveform: ClassicWaveform
    /** Volume in decibels */
    volume: number
    /** Octave offset (-3 to 3) */
    octave: int
    /** Fine-tuning in cents (-1200 to 1200) */
    tune: float
}

/** Vaporisateur LFO configuration */
export interface VaporisateurLFO {
    /** LFO waveform type (sine, triangle, saw, square) */
    waveform: ClassicWaveform
    /** LFO rate in Hz (0.0001 to 30) */
    rate: float
    /** Sync LFO to tempo */
    sync: boolean
    /** LFO modulation amount to pitch (-1.0 to 1.0) */
    targetTune: bipolar
    /** LFO modulation amount to filter cutoff (-1.0 to 1.0) */
    targetCutoff: bipolar
    /** LFO modulation amount to volume (-1.0 to 1.0) */
    targetVolume: bipolar
}

/** Vaporisateur noise generator configuration */
export interface VaporisateurNoise {
    /** Attack time in seconds (0.001 to 5.0) */
    attack: float
    /** Hold time in seconds (0.001 to 5.0) */
    hold: float
    /** Release time in seconds (0.001 to 5.0) */
    release: float
    /** Volume in decibels */
    volume: number
}

/** Classic subtractive synthesizer instrument */
export interface Vaporisateur extends MIDIInstrument {
    /** Filter cutoff frequency in Hz (20 to 20000) */
    cutoff: float
    /** Filter resonance (0.01 to 10.0) */
    resonance: float
    /** Filter order/poles (1, 2, 3 or 4) */
    filterOrder: 1 | 2 | 3 | 4
    /** Filter envelope modulation amount (-1.0 to 1.0) */
    filterEnvelope: bipolar
    /** Filter keyboard tracking amount (-1.0 to 1.0) */
    filterKeyboard: bipolar
    /** Amplitude envelope attack time in seconds (0.001 to 5.0) */
    attack: float
    /** Amplitude envelope decay time in seconds (0.001 to 5.0) */
    decay: float
    /** Amplitude envelope sustain level (0.0 to 1.0) */
    sustain: unitValue
    /** Amplitude envelope release time in seconds (0.001 to 5.0) */
    release: float
    /** Voice mode (monophonic or polyphonic) */
    voicingMode: VoicingMode
    /** Glide/portamento time (0.0 to 1.0) */
    glideTime: unitValue
    /** Number of unison voices (1, 3 or 5) */
    unisonCount: 1 | 3 | 5
    /** Unison detune amount in cents (1 to 1200) */
    unisonDetune: float
    /** Unison stereo spread (0.0 to 1.0) */
    unisonStereo: unitValue
    /** LFO configuration */
    lfo: VaporisateurLFO
    /** Two oscillators */
    oscillators: [VaporisateurOscillator, VaporisateurOscillator]
    /** Noise generator configuration */
    noise: VaporisateurNoise
}

/** Sample-based playback instrument */
export interface Playfield extends MIDIInstrument {}

/** Minimal synthesizer instrument */
export interface Nano extends MIDIInstrument {
    sample: Sample
}

/** SoundFont (.sf2) player instrument */
export interface Soundfont extends MIDIInstrument {}

/** External MIDI output instrument */
export interface MIDIOutput extends MIDIInstrument {}

export interface Tape extends AudioInstrument {}

export type Instruments = {
    "Vaporisateur": Vaporisateur
    "Playfield": Playfield
    "Nano": Nano
    "Soundfont": Soundfont
    "MIDIOutput": MIDIOutput
    "Tape": Tape
}

export interface Project {
    /** Master output audio unit */
    readonly output: OutputAudioUnit
    /** Project name */
    name: string
    /** Tempo in beats per minute */
    bpm: number
    /** Time signature (e.g., 4/4, 3/4) */
    timeSignature: { numerator: int, denominator: int }
    /** Add an instrument track to the project */
    addInstrumentUnit<KEY extends keyof Instruments>(name: KEY, constructor?: Procedure<Instruments[KEY]>): InstrumentAudioUnit
    /** Add an auxiliary effects track */
    addAuxUnit(props?: Partial<Pick<AuxAudioUnit, "label">>): AuxAudioUnit
    /** Add a group track for mixing multiple units */
    addGroupUnit(props?: Partial<Pick<GroupAudioUnit, "label">>): GroupAudioUnit
    /** Open the project in the studio and exit */
    openInStudio(): void
}

export interface Api {
    /** Create a new project */
    newProject(name?: string): Project
    /** Get the current active project */
    getProject(): Promise<Project>
    /** Creates a sample in the studio **/
    addSample(data: AudioData, name: string): Promise<Sample>
}