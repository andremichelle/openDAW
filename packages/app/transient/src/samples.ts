import {AudioData, WavFile} from "@opendaw/lib-dsp"

// Served from public/samples -> repo-root test-files/samples (symlink).
const BASE = "/samples/"

export const SAMPLE_FILES: ReadonlyArray<string> = [
    "175_F_AttackHitLoop_SP_02.wav",
    "RK_Techno_Top_Loop1_05_128bpm.wav",
    "RK_DTC1_Dub_Chord_02_125bpm_Am.wav",
    "568315__valentinsosnitskiy__classical-loop-guitar-4-chords.wav",
    "TKNVLT_FREE_HT_STORY_1.wav",
    "332740__mseq__derelict-pad-125.wav",
    "861020__formaudioworks__fa_free_85_pad_loop_borealis_dbm.wav",
    "543732__nnaudio__alien-drone-sine-pad-08-135bpm-amin-new-nation.wav"
]

export interface LoadedSample {
    name: string
    audio: AudioData
}

export const loadSample = async (name: string): Promise<LoadedSample> => {
    const wav = await fetch(BASE + name).then(response => response.arrayBuffer())
    const audio = WavFile.decodeFloats(wav)
    return {name, audio}
}
