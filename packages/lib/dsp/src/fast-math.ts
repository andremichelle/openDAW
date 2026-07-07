// WASM CONTRACT: fast transcendental approximations, mirrored OPERATION-FOR-OPERATION with the Rust
// `dsp::fast_math`. Both engines run the identical f64 arithmetic (same folds, same Horner nesting, same
// constants written as exact small-integer fractions), so the results are bit-identical across TS and
// WASM — stronger than the two different Math / libm implementations they replace. Audio-grade accuracy:
// the truncation error is below -140 dB, far under the f32 output quantisation.

const TAU = Math.PI * 2.0
const LN_2 = Math.LN2

// `sin(TAU * phase)` for any finite `phase` (a NORMALIZED phase, one period per unit). Folds to the
// quarter wave and evaluates a degree-11 odd Taylor polynomial on `[-PI/2, PI/2]` (max error ~6e-8).
export const fastSinTau = (phase: number): number => {
    const turns = phase - Math.floor(phase)
    const half = turns >= 0.5 ? turns - 1.0 : turns
    const quarter = half > 0.25 ? 0.5 - half : half < -0.25 ? -0.5 - half : half
    const t = quarter * TAU
    const z = t * t
    return t * (1.0 + z * (-1.0 / 6.0 + z * (1.0 / 120.0 + z * (-1.0 / 5040.0 + z * (1.0 / 362880.0 + z * (-1.0 / 39916800.0))))))
}

// `2^x` for the audio modulation range (`|x|` up to ~64 octaves). Splits into an exact power-of-two scale
// and a degree-9 Taylor of `e^(f * ln 2)` on `[0, ln 2)` (max error ~7e-9). The scale is built in constant
// time by writing the biased exponent straight into IEEE-754 bits (mirroring Rust's `f64::from_bits`) — the
// exact same `2^steps` the old repeated-multiply loop produced, bit-for-bit, minus the up-to-64-step loop.
const EXP2_BUFFER = new ArrayBuffer(8)
const EXP2_F64 = new Float64Array(EXP2_BUFFER)
const EXP2_U32 = new Uint32Array(EXP2_BUFFER)

export const fastExp2 = (x: number): number => {
    const i = Math.floor(x)
    const u = (x - i) * LN_2
    const p = 1.0 + u * (1.0 + u * (1.0 / 2.0 + u * (1.0 / 6.0 + u * (1.0 / 24.0 + u * (1.0 / 120.0 + u * (1.0 / 720.0 + u * (1.0 / 5040.0 + u * (1.0 / 40320.0 + u * (1.0 / 362880.0)))))))))
    const steps = i > 64.0 ? 64 : i < -64.0 ? -64 : i
    EXP2_U32[1] = (steps + 1023) << 20
    EXP2_U32[0] = 0
    const scale = EXP2_F64[0]
    return p * scale
}

// One reused view for the IEEE-754 exponent/mantissa split (allocation-free). The typed-array read differs
// in FORM from Rust's `f64::to_bits`, but yields the identical exponent + mantissa on the (little-endian)
// target, so the subsequent arithmetic stays bit-for-bit mirrored.
const LOG2_BUFFER = new ArrayBuffer(8)
const LOG2_F64 = new Float64Array(LOG2_BUFFER)
const LOG2_U32 = new Uint32Array(LOG2_BUFFER)

// `log2(x)` for `x > 0` (audio levels at or above a small positive floor). The inverse mirror of `fastExp2`:
// extracts the IEEE-754 exponent EXACTLY, then approximates the mantissa's log2 on `[1, 2)` with the odd
// `atanh` series in `f = (m - 1) / (m + 1)` up to `f^15` (max error ~1e-8, below -140 dB).
export const fastLog2 = (x: number): number => {
    LOG2_F64[0] = x
    const hi = LOG2_U32[1]
    const exponent = ((hi >>> 20) & 0x7FF) - 1023
    LOG2_U32[1] = (hi & 0x000FFFFF) | 0x3FF00000
    const mantissa = LOG2_F64[0]
    const f = (mantissa - 1.0) / (mantissa + 1.0)
    const f2 = f * f
    const series = f * (1.0 + f2 * (1.0 / 3.0 + f2 * (1.0 / 5.0 + f2 * (1.0 / 7.0 + f2 * (1.0 / 9.0 + f2 * (1.0 / 11.0 + f2 * (1.0 / 13.0 + f2 * (1.0 / 15.0))))))))
    return exponent + series * (2.0 / LN_2)
}
