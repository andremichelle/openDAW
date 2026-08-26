import {AudioPitchStretchBoxAdapter} from "./AudioPitchStretchBoxAdapter"
import {AudioTimeStretchBoxAdapter} from "./AudioTimeStretchBoxAdapter"
import {AudioSignalsmithBoxAdapter} from "./AudioSignalsmithBoxAdapter"

export namespace AudioPlayMode {
    export const isAudioPlayMode = (mode: unknown): mode is AudioPlayMode =>
        mode instanceof AudioPitchStretchBoxAdapter
        || mode instanceof AudioTimeStretchBoxAdapter
        || mode instanceof AudioSignalsmithBoxAdapter
}

export type AudioPlayMode = AudioPitchStretchBoxAdapter | AudioTimeStretchBoxAdapter | AudioSignalsmithBoxAdapter