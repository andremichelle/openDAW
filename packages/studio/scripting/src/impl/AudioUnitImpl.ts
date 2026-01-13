import {
    AnyDevice,
    AudioEffects,
    AudioTrack,
    AudioUnit,
    GroupAudioUnit,
    MIDIEffects,
    NoteTrack,
    OutputAudioUnit,
    ValueTrack
} from "../Api"
import {ProjectImpl} from "./ProjectImpl"
import {NoteTrackImpl} from "./NoteTrackImpl"
import {ValueTrackImpl} from "./ValueTrackImpl"
import {DelayEffectImpl} from "./DelayEffectImpl"
import {PitchEffectImpl} from "./PitchEffectImpl"
import {bipolar, Nullable} from "@moises-ai/lib-std"
import {AudioTrackImpl} from "./AudioTrackImpl"

export abstract class AudioUnitImpl implements AudioUnit {
    readonly #audioEffects: Array<AudioEffects[keyof AudioEffects]>
    readonly #midiEffects: Array<MIDIEffects[keyof MIDIEffects]>
    readonly #noteTracks: Array<NoteTrackImpl>
    readonly #valueTracks: Array<ValueTrackImpl>
    readonly #audioTracks: Array<AudioTrackImpl>

    output?: Nullable<OutputAudioUnit | GroupAudioUnit>
    volume: number
    panning: bipolar
    mute: boolean
    solo: boolean

    protected constructor(props?: Partial<AudioUnit>) {
        this.#audioEffects = []
        this.#midiEffects = []
        this.#noteTracks = []
        this.#audioTracks = []
        this.#valueTracks = []

        this.output = props?.output
        this.volume = props?.volume ?? 0.0
        this.panning = props?.panning ?? 0.0
        this.mute = props?.mute ?? false
        this.solo = props?.solo ?? false
    }

    addMIDIEffect<T extends keyof MIDIEffects>(type: T, props?: Partial<MIDIEffects[T]>): MIDIEffects[T] {
        let effect: MIDIEffects[T]
        switch (type) {
            case "pitch":
                effect = new PitchEffectImpl(props) as MIDIEffects[T]
                break
            default:
                throw new Error(`Unknown MIDI effect type: ${type}`)
        }
        this.#midiEffects.push(effect)
        return effect
    }

    addAudioEffect<T extends keyof AudioEffects>(type: T, props?: Partial<AudioEffects[T]>): AudioEffects[T] {
        let effect: AudioEffects[T]
        switch (type) {
            case "delay":
                effect = new DelayEffectImpl(props) as AudioEffects[T]
                break
            default:
                throw new Error(`Unknown Audio effect type: ${type}`)
        }
        this.#audioEffects.push(effect)
        return effect
    }

    addNoteTrack(props?: Partial<NoteTrack>): NoteTrack {
        const track = new NoteTrackImpl(this, props)
        this.#noteTracks.push(track)
        return track
    }

    addAudioTrack(props?: Partial<AudioTrack>): AudioTrack {
        const track = new AudioTrackImpl(this, props)
        this.#audioTracks.push(track)
        return track
    }

    addValueTrack<DEVICE extends AnyDevice, PARAMETER extends keyof DEVICE>(
        device: DEVICE,
        parameter: PARAMETER, props?: Partial<ValueTrack>): ValueTrack {
        const track = new ValueTrackImpl<DEVICE, PARAMETER>(this, device, parameter, props)
        this.#valueTracks.push(track as any)
        return track
    }

    get audioEffects(): ReadonlyArray<AudioEffects[keyof AudioEffects]> {return this.#audioEffects}
    get midiEffects(): ReadonlyArray<MIDIEffects[keyof MIDIEffects]> {return this.#midiEffects}
    get noteTracks(): ReadonlyArray<NoteTrackImpl> {return this.#noteTracks}
    get audioTracks(): ReadonlyArray<AudioTrackImpl> {return this.#audioTracks}
    get valueTracks(): ReadonlyArray<ValueTrackImpl> {return this.#valueTracks}
}