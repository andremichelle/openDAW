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

// `2^x` for the audio modulation range (`|x|` up to ~64 octaves). Splits into an exact power-of-two
// scale and a degree-9 Taylor of `e^(f * ln 2)` on `[0, ln 2)` (max error ~7e-9).
export const fastExp2 = (x: number): number => {
    const i = Math.floor(x)
    const u = (x - i) * LN_2
    const p = 1.0 + u * (1.0 + u * (1.0 / 2.0 + u * (1.0 / 6.0 + u * (1.0 / 24.0 + u * (1.0 / 120.0 + u * (1.0 / 720.0 + u * (1.0 / 5040.0 + u * (1.0 / 40320.0 + u * (1.0 / 362880.0)))))))))
    const steps = i > 64.0 ? 64 : i < -64.0 ? -64 : i
    let scale = 1.0
    if (steps >= 0) {
        for (let step = 0; step < steps; step++) {scale *= 2.0} // exact
    } else {
        for (let step = 0; step < -steps; step++) {scale *= 0.5} // exact
    }
    return p * scale
}
