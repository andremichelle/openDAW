//! Shared, `no_std`, dependency-free DSP primitives used by the feature entry-point crates.

#![no_std]

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
