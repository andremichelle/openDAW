//! Curve math, mirroring lib-std `curve.ts`, in f32 (the signal/control-path precision). A single
//! `slope` in (0,1) shapes an exponential curve between `y0` and `y1`; slope 0.5 is linear. libm
//! `powf`/`logf` keep it `no_std` and identical across host and wasm. Inputs are segment-relative
//! (small), so f32 is precise enough; absolute positions stay f64 in the transport.

use libm::{fabsf, logf, powf};
use crate::clamp;

const EPSILON: f32 = 1.0e-7;

/// Normalized curve y in [0,1] for x in [0,1]. slope 0.5 is the identity (linear).
pub fn normalized_at(x: f32, slope: f32) -> f32 {
    if slope > 0.499999 && slope < 0.500001 {
        x
    } else {
        let p = clamp(slope, EPSILON, 1.0 - EPSILON);
        (p * p) / (1.0 - p * 2.0) * (powf((1.0 - p) / p, 2.0 * x) - 1.0)
    }
}

/// Curve value at `x` in [0, steps], mapped from `y0` to `y1`.
pub fn value_at(slope: f32, steps: f32, y0: f32, y1: f32, x: f32) -> f32 {
    normalized_at(x / steps, slope) * (y1 - y0) + y0
}

/// Inverse of `normalized_at`: the x in [0,1] that yields normalized `y`.
pub fn inverse_at(y: f32, slope: f32) -> f32 {
    let p = clamp(slope, EPSILON, 1.0 - EPSILON);
    logf((y * (1.0 - 2.0 * p) / (p * p)) + 1.0) / (2.0 * logf((1.0 - p) / p))
}

/// Recurrence coefficients `(m, q)` such that `v_{i+1} = m*v_i + q` walks the curve from `y0`,
/// matching `value_at` at integer steps. Lets a curve segment be filled per-sample without `powf`.
pub fn coefficients(slope: f32, steps: f32, y0: f32, y1: f32) -> (f32, f32) {
    let f1 = value_at(slope, steps, y0, y1, 1.0);
    let f2 = value_at(slope, steps, y0, y1, 2.0);
    let m = (f2 - f1) / (f1 - y0);
    let q = f1 - m * y0;
    (m, q)
}

/// Slope that makes the curve pass through `ym` at the midpoint between `y0` and `y1`.
pub fn slope_by_half(y0: f32, ym: f32, y1: f32) -> f32 {
    if fabsf(y1 - y0) < 1e-6 {
        0.5
    } else {
        (ym - y0) / (y1 - y0)
    }
}
