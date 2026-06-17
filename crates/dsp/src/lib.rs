//! Shared, `no_std`, dependency-free DSP primitives used by the feature entry-point crates.
//! `no_std` for the wasm build; native `cargo test` builds with std so primitives can be unit-tested
//! against the standard library (the native-unit level of plans/wasm-audio/07-testing.md).

#![cfg_attr(not(test), no_std)]

pub const PI: f32 = 3.141_592_7;

#[inline]
pub fn fabs(x: f32) -> f32 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}

/// Parabolic sine approximation for `x` in `[-PI, PI]` (good enough for a test tone).
#[inline]
pub fn fast_sin(x: f32) -> f32 {
    const B: f32 = 4.0 / PI;
    const C: f32 = -4.0 / (PI * PI);
    let y = B * x + C * x * fabs(x);
    0.225 * (y * fabs(y) - y) + y
}

#[cfg(test)]
mod tests {
    use super::{fabs, fast_sin, PI};

    #[test]
    fn fabs_matches_std() {
        assert_eq!(fabs(-3.5), 3.5);
        assert_eq!(fabs(2.0), 2.0);
        assert_eq!(fabs(0.0), 0.0);
    }

    #[test]
    fn fast_sin_approximates_std_sin() {
        let steps = 2000;
        let mut max_error = 0.0f32;
        for index in 0..=steps {
            let x = -PI + (2.0 * PI) * (index as f32) / (steps as f32);
            let error = (fast_sin(x) - x.sin()).abs();
            if error > max_error {
                max_error = error;
            }
        }
        assert!(max_error < 0.02, "parabolic sine error {max_error} exceeds tolerance");
    }
}
