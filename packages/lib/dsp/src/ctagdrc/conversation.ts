import {fastExp2, fastLog2} from "../fast-math"

// dB conversions, called PER SAMPLE in the compressor's gain path, so they use the fast approximations.
// WASM CONTRACT: LOG10_2 / LOG2_10 use the identical literals as the Rust `dsp::ctagdrc`, and fastLog2 /
// fastExp2 are the mirrored fast-math, so these run bit-for-bit identically across TS and WASM.
const LOG10_2 = 0.301029995663981195
const LOG2_10 = 3.321928094887362348

export const gainToDecibels = (gain: number): number => gain > 0 ? 20.0 * fastLog2(gain) * LOG10_2 : -100.0
export const decibelsToGain = (db: number): number => fastExp2(db * 0.05 * LOG2_10)