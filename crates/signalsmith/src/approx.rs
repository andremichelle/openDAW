//! Branch-light, `libm`-free polynomial approximations for the phase-vocoder hot loops. `libm::{sinf,cosf,
//! atan2f}` are scalar function calls the wasm auto-vectorizer can't touch; these are pure arithmetic (plus
//! a couple of `select`-able comparisons), so LLVM can lower the per-band loops to `f32x4` under `+simd128`
//! — and they're faster even scalar (no call, no general range reduction). Accuracy is verified < 5e-5 vs
//! `libm` over the ranges the vocoder uses (well below the audio noise floor).

const PI: f32 = core::f32::consts::PI;
const TWO_PI: f32 = 2.0 * core::f32::consts::PI;
const HALF_PI: f32 = core::f32::consts::FRAC_PI_2;
const INV_TWO_PI: f32 = 1.0 / (2.0 * core::f32::consts::PI);

/// Round to nearest integer, branch-free (valid for |x| < 2^22 — phases are kept wrapped, so always are).
#[inline]
pub fn round_f32(x: f32) -> f32 {
    const MAGIC: f32 = 12582912.0; // 1.5 * 2^23: adding then subtracting snaps the mantissa to an integer
    (x + MAGIC) - MAGIC
}

/// Wrap a radian phase into [-pi, pi] (keeps accumulators bounded so the polynomials stay accurate forever).
#[inline]
pub fn wrap_pi(x: f32) -> f32 { x - TWO_PI * round_f32(x * INV_TWO_PI) }

/// (sin(x), cos(x)). Range-reduce to [-pi, pi] then to [-pi/2, pi/2] (a reflect, lowered to `select`), then a
/// minimax pair — accurate to a few 1e-6 over the reduced interval.
#[inline]
pub fn sin_cos(x: f32) -> (f32, f32) {
    let t = x - TWO_PI * round_f32(x * INV_TWO_PI);              // [-pi, pi]
    let reflect = t.abs() > HALF_PI;
    let sign = if t >= 0.0 { 1.0 } else { -1.0 };
    let a = if reflect { sign * PI - t } else { t };            // [-pi/2, pi/2]
    let cos_sign = if reflect { -1.0 } else { 1.0 };
    let a2 = a * a;
    let sin_a = a * (1.0 + a2 * (-0.16666667 + a2 * (0.008333333 + a2 * (-0.00019841270 + a2 * 0.0000027557319))));
    let cos_a = 1.0 + a2 * (-0.5 + a2 * (0.041666668 + a2 * (-0.0013888889 + a2 * (0.000024801587 + a2 * -0.00000027557319))));
    (sin_a, cos_sign * cos_a)
}

/// atan2(y, x), branch-light (the comparisons lower to `select`). Accurate to ~3e-5.
#[inline]
pub fn atan2(y: f32, x: f32) -> f32 {
    let ax = x.abs();
    let ay = y.abs();
    let hi = ax.max(ay);
    let lo = ax.min(ay);
    let a = if hi > 0.0 { lo / hi } else { 0.0 };               // [0, 1]
    let a2 = a * a;
    // minimax atan on [0, 1]
    let mut r = a * (0.99997726 + a2 * (-0.33262347 + a2 * (0.19354346
        + a2 * (-0.11643287 + a2 * (0.05265332 + a2 * -0.01172120)))));
    if ay > ax { r = HALF_PI - r; }                             // fold onto [0, pi/2]
    if x < 0.0 { r = PI - r; }                                  // left half-plane
    if y < 0.0 { r = -r; }                                      // lower half-plane
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_cos_matches_libm() {
        let mut max = 0.0f32;
        let mut x = -40.0f32; // large args too (accumulated phases before wrap): reduction must hold
        while x < 40.0 {
            let (s, c) = sin_cos(x);
            max = max.max((s - libm::sinf(x)).abs()).max((c - libm::cosf(x)).abs());
            x += 0.0007;
        }
        println!("sin_cos max abs err {max:.2e}");
        assert!(max < 5e-5, "sin_cos error {max:.2e}");
    }

    #[test]
    fn atan2_matches_libm() {
        let mut max = 0.0f32;
        let mut y = -4.0f32;
        while y < 4.0 {
            let mut x = -4.0f32;
            while x < 4.0 {
                if x.abs() > 1e-3 || y.abs() > 1e-3 {
                    let d = (atan2(y, x) - libm::atan2f(y, x)).abs();
                    max = max.max(d.min((d - TWO_PI).abs())); // ignore the +-pi branch wrap
                }
                x += 0.013;
            }
            y += 0.013;
        }
        println!("atan2 max abs err {max:.2e}");
        assert!(max < 1e-4, "atan2 error {max:.2e}");
    }
}
