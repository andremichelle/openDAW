import {PPQN} from "./ppqn"

export const RenderQuantum = 128 | 0
export const TempoChangeGrid = PPQN.fromSignature(1, 48) // make dynamic window 10ms
export const SILENCE_THRESHOLD = 1e-4 // ≈ -80 dB