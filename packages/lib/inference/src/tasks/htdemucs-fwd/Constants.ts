export const TARGET_SAMPLE_RATE = 44100
export const SEGMENT_LENGTH = 343980
export const OVERLAP = 171990
export const HOP = SEGMENT_LENGTH - OVERLAP

export const STFT_N_FFT = 4096
export const STFT_HOP = 1024
export const STFT_FREQ_BINS = 2048
export const STFT_TIME_FRAMES = 336
export const STFT_DEMUCS_PAD_LEFT = 1536
export const STFT_CENTER_PAD = STFT_N_FFT / 2
export const STFT_NORM = 1.0 / Math.sqrt(STFT_N_FFT)

export const HT_EPS = 1e-5

export const NUM_STEMS = 4
export const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const
export type StemName = typeof STEM_NAMES[number]
