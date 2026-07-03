//! WASM CONTRACT: fast transcendental approximations, mirrored OPERATION-FOR-OPERATION with lib-dsp
//! `fast-math.ts`. Both engines run the identical f64 arithmetic (same folds, same Horner nesting, same
//! constants written as exact small-integer fractions), so the results are bit-identical across TS and
//! WASM — stronger than the two different `libm` / V8 implementations they replace. Audio-grade accuracy:
//! the truncation error is below -140 dB, far under the f32 output quantisation.

use core::f64::consts::{LN_2, TAU};

/// `sin(TAU * phase)` for any finite `phase` (a NORMALIZED phase, one period per unit). Folds to the
/// quarter wave and evaluates a degree-11 odd Taylor polynomial on `[-PI/2, PI/2]` (max error ~6e-8).
pub fn fast_sin_tau(phase: f64) -> f64 {
    let turns = phase - floor(phase);
    let half = if turns >= 0.5 { turns - 1.0 } else { turns };
    let quarter = if half > 0.25 {
        0.5 - half
    } else if half < -0.25 {
        -0.5 - half
    } else {
        half
    };
    let t = quarter * TAU;
    let z = t * t;
    t * (1.0 + z * (-1.0 / 6.0 + z * (1.0 / 120.0 + z * (-1.0 / 5040.0 + z * (1.0 / 362880.0 + z * (-1.0 / 39916800.0))))))
}

/// `2^x` for the audio modulation range (`|x|` up to ~64 octaves). Splits into an exact power-of-two
/// scale and a degree-9 Taylor of `e^(f * ln 2)` on `[0, ln 2)` (max error ~7e-9).
pub fn fast_exp2(x: f64) -> f64 {
    let i = floor(x);
    let u = (x - i) * LN_2;
    let p = 1.0 + u * (1.0 + u * (1.0 / 2.0 + u * (1.0 / 6.0 + u * (1.0 / 24.0 + u * (1.0 / 120.0 + u * (1.0 / 720.0 + u * (1.0 / 5040.0 + u * (1.0 / 40320.0 + u * (1.0 / 362880.0)))))))));
    let steps = clamp_exponent(i);
    let mut scale = 1.0f64;
    if steps >= 0 {
        for _ in 0..steps {
            scale *= 2.0; // exact
        }
    } else {
        for _ in 0..-steps {
            scale *= 0.5; // exact
        }
    }
    p * scale
}

// `libm::floor` on wasm, kept as one shared spot (TS uses `Math.floor`, the identical operation).
#[inline]
fn floor(value: f64) -> f64 {
    libm::floor(value)
}

#[inline]
fn clamp_exponent(i: f64) -> i32 {
    if i > 64.0 {
        64
    } else if i < -64.0 {
        -64
    } else {
        i as i32
    }
}

#[cfg(test)]
mod tests {
    use super::{fast_exp2, fast_sin_tau};

    #[test]
    fn sin_matches_libm_within_audio_accuracy() {
        let mut max_error = 0.0f64;
        for step in -4000..4000 {
            let phase = step as f64 / 1000.0;
            let error = (fast_sin_tau(phase) - libm::sin(phase * core::f64::consts::TAU)).abs();
            if error > max_error {
                max_error = error;
            }
        }
        assert!(max_error < 1.0e-7, "max sin error {max_error}");
    }

    #[test]
    fn exp2_matches_libm_within_audio_accuracy() {
        let mut max_relative = 0.0f64;
        for step in -3000..3000 {
            let x = step as f64 / 1000.0;
            let exact = libm::exp2(x);
            let relative = ((fast_exp2(x) - exact) / exact).abs();
            if relative > max_relative {
                max_relative = relative;
            }
        }
        assert!(max_relative < 1.0e-8, "max exp2 relative error {max_relative}");
    }

    #[test]
    fn edge_values_are_sane() {
        assert_eq!(fast_sin_tau(0.0), 0.0);
        assert_eq!(fast_exp2(0.0), 1.0);
        assert_eq!(fast_exp2(1.0), 2.0);
        assert_eq!(fast_exp2(-1.0), 0.5);
        assert!((fast_sin_tau(0.25) - 1.0).abs() < 1.0e-7);
        assert!((fast_sin_tau(0.75) + 1.0).abs() < 1.0e-7);
    }
}
