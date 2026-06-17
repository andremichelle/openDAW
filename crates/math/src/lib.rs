//! Shared math primitives and constants (the lib-std equivalent for the engine crates): clamp, lerp,
//! fabs, PI, a parabolic sine approximation, and the `curve` module. `no_std`; libm-backed where it
//! needs transcendentals, so host tests and the wasm build compute identically.

#![cfg_attr(not(test), no_std)]

pub mod curve;

/// Pi as f32 (DSP-grade; mirrors the value used by the feature crates).
pub const PI: f32 = 3.141_592_7;

#[inline]
pub fn fabs(x: f32) -> f32 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}

/// Clamp `value` into `[min, max]`. Generic over any ordered type (f32, f64, integers): the Rust way
/// to "overload" is a single generic function, not multiple same-named ones.
pub fn clamp<T: PartialOrd>(value: T, min: T, max: T) -> T {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/// Linear interpolation from `a` to `b` by `t`. Arithmetic-generic `lerp` needs num traits and isn't
/// worth it yet, so this stays f32 (the signal-path precision); add `lerp64` only if a caller needs it.
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Parabolic sine approximation for `x` in `[-PI, PI]` (good enough for a test tone / click).
#[inline]
pub fn fast_sin(x: f32) -> f32 {
    const B: f32 = 4.0 / PI;
    const C: f32 = -4.0 / (PI * PI);
    let y = B * x + C * x * fabs(x);
    0.225 * (y * fabs(y) - y) + y
}
