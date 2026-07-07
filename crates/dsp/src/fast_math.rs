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
/// scale and a degree-9 Taylor of `e^(f * ln 2)` on `[0, ln 2)` (max error ~7e-9). The scale is built in
/// constant time by writing the biased exponent straight into IEEE-754 bits — the exact same `2^steps` the
/// old repeated-multiply loop produced, bit-for-bit, but without the up-to-64-step loop that made this
/// slower than libm's `exp2`. `steps` is clamped to `[-64, 64]`, so `steps + 1023` stays a valid exponent.
pub fn fast_exp2(x: f64) -> f64 {
    let i = floor(x);
    let u = (x - i) * LN_2;
    let p = 1.0 + u * (1.0 + u * (1.0 / 2.0 + u * (1.0 / 6.0 + u * (1.0 / 24.0 + u * (1.0 / 120.0 + u * (1.0 / 720.0 + u * (1.0 / 5040.0 + u * (1.0 / 40320.0 + u * (1.0 / 362880.0)))))))));
    let steps = clamp_exponent(i);
    let scale = f64::from_bits(((steps + 1023) as u64) << 52);
    p * scale
}

/// `log2(x)` for `x > 0` (audio levels at or above a small positive floor). The inverse mirror of
/// `fast_exp2`: extracts the IEEE-754 exponent EXACTLY, then approximates the mantissa's log2 on `[1, 2)`
/// with the odd `atanh` series in `f = (m - 1) / (m + 1)` up to `f^15` (max error ~1e-8, below -140 dB).
/// Undefined for `x <= 0` — callers clamp to a positive floor.
pub fn fast_log2(x: f64) -> f64 {
    let bits = x.to_bits();
    let exponent = ((bits >> 52) & 0x7FF) as i64 - 1023;
    let mantissa = f64::from_bits((bits & 0x000F_FFFF_FFFF_FFFF) | 0x3FF0_0000_0000_0000);
    let f = (mantissa - 1.0) / (mantissa + 1.0);
    let f2 = f * f;
    let series = f * (1.0 + f2 * (1.0 / 3.0 + f2 * (1.0 / 5.0 + f2 * (1.0 / 7.0 + f2 * (1.0 / 9.0 + f2 * (1.0 / 11.0 + f2 * (1.0 / 13.0 + f2 * (1.0 / 15.0))))))));
    exponent as f64 + series * (2.0 / LN_2)
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
    use super::{fast_exp2, fast_log2, fast_sin_tau};

    #[test]
    fn log2_matches_libm_within_audio_accuracy() {
        // Sweep the level range the compressor feeds it (a small floor up to well above unity). The ABSOLUTE
        // error bounds the dB error: gain_to_decibels ≈ 6.02 * fast_log2, so 1e-7 here is < 1e-6 dB.
        let mut max_error = 0.0f64;
        for step in 1..200_000 {
            let x = step as f64 / 12_500.0; // 8e-5 .. 16.0
            let error = (fast_log2(x) - libm::log2(x)).abs();
            if error > max_error {
                max_error = error;
            }
        }
        assert!(max_error < 1.0e-7, "max log2 error {max_error}");
    }

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
        assert_eq!(fast_log2(1.0), 0.0); // powers of two are EXACT (mantissa 1.0 -> zero series)
        assert_eq!(fast_log2(2.0), 1.0);
        assert_eq!(fast_log2(0.5), -1.0);
        assert!((fast_sin_tau(0.25) - 1.0).abs() < 1.0e-7);
        assert!((fast_sin_tau(0.75) + 1.0).abs() < 1.0e-7);
    }
}

/// Host-native timing of each fast approximation against its libm counterpart. NOT wasm — the absolute
/// numbers and even the sign of the win can differ once wasm-opt is applied and the code runs under the
/// wasm engine (see `fast_exp2` below), so treat these as a directional guide, not the ground truth the
/// `/performance` page provides. Ignored by default (they take a few seconds and only make sense in release);
/// run explicitly:  `cargo test -p dsp --release fast_math::perf -- --ignored --nocapture --test-threads=1`
#[cfg(test)]
mod perf {
    use super::{fast_exp2, fast_log2, fast_sin_tau};
    use core::f64::consts::TAU;
    use std::hint::black_box;
    use std::time::Instant;

    // Best-of-5 ns/op over the input sweep; black_box on both the input and the accumulator so the loop is
    // neither hoisted nor eliminated.
    fn measure(inputs: &[f64], iters: usize, func: &dyn Fn(f64) -> f64) -> f64 {
        let mut best = f64::MAX;
        for _ in 0..5 {
            let start = Instant::now();
            let mut acc = 0.0f64;
            for _ in 0..iters {
                for &x in inputs {
                    acc += func(black_box(x));
                }
            }
            black_box(acc);
            let ns = start.elapsed().as_nanos() as f64 / (iters * inputs.len()) as f64;
            if ns < best {
                best = ns;
            }
        }
        best
    }

    fn report(name: &str, inputs: &[f64], fast: &dyn Fn(f64) -> f64, native: &dyn Fn(f64) -> f64) {
        for &x in inputs {
            black_box(fast(x) + native(x)); // warm the caches / branch predictor
        }
        let fast_ns = measure(inputs, 5_000, fast);
        let native_ns = measure(inputs, 5_000, native);
        println!("{name:22} fast {fast_ns:6.3} ns/op   libm {native_ns:6.3} ns/op   speedup {:.2}x", native_ns / fast_ns);
    }

    #[test]
    #[ignore]
    fn sin_tau_vs_libm_sin() {
        let inputs: Vec<f64> = (-400..400).map(|step| step as f64 / 100.0).collect();
        report("sin_tau [-4..4]", &inputs, &|x| fast_sin_tau(x), &|x| libm::sin(x * TAU));
        for &x in &inputs {
            assert!((fast_sin_tau(x) - libm::sin(x * TAU)).abs() < 1.0e-7);
        }
    }

    #[test]
    #[ignore]
    fn log2_vs_libm_log2() {
        let inputs: Vec<f64> = (1..=1000).map(|step| step as f64 / 62.5).collect(); // 0.016 .. 16
        report("log2 [0.016..16]", &inputs, &|x| fast_log2(x), &|x| libm::log2(x));
        for &x in &inputs {
            assert!((fast_log2(x) - libm::log2(x)).abs() < 1.0e-7);
        }
    }

    // exp2 is swept at three magnitudes on purpose: the power-of-two scaling is an iterative loop, so the win
    // ERODES as |x| grows (the loop runs up to 64 steps). This is why Tidal — which feeds large-magnitude
    // exponents — is faster on libm `exp2`, while the compressor's small-|x| gain path is faster on `fast_exp2`.
    #[test]
    #[ignore]
    fn exp2_vs_libm_exp2() {
        for (label, lo, hi) in [("exp2 [-4..4]", -40, 40), ("exp2 [-16..16]", -160, 160), ("exp2 [-50..50]", -500, 500)] {
            let inputs: Vec<f64> = (lo..hi).map(|step| step as f64 / 10.0).collect();
            report(label, &inputs, &|x| fast_exp2(x), &|x| libm::exp2(x));
            for &x in &inputs {
                let relative = ((fast_exp2(x) - libm::exp2(x)) / libm::exp2(x)).abs();
                assert!(relative < 1.0e-8, "exp2 relative error {relative} at {x}");
            }
        }
    }
}
