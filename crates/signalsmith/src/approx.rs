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

/// sqrt via fast inverse-sqrt + two Newton steps (`x * rsqrt(x)`). Pure arithmetic + bitcast (vectorizable),
/// ~1e-5 relative error — plenty for a magnitude. Zero/negative -> 0.
#[inline]
pub fn sqrt(x: f32) -> f32 {
    let i = 0x5f37_5a86u32.wrapping_sub(x.to_bits() >> 1);
    let mut y = f32::from_bits(i);
    y = y * (1.5 - 0.5 * x * y * y);
    y = y * (1.5 - 0.5 * x * y * y);
    let r = x * y;
    if x > 0.0 { r } else { 0.0 }
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

// ---- 4-wide (SIMD) counterparts -----------------------------------------------------------------------------
// Same coefficients and evaluation ORDER as the scalar versions above, so each lane is bit-identical to the
// scalar function (verified in tests). Written against `Simd4`, which is wasm `f32x4` intrinsics on wasm32 and
// a scalar `[f32;4]` fallback elsewhere — so the native tests exercise the exact algorithm the wasm runs.
use crate::simd::Simd4;

#[inline]
pub fn round4(x: Simd4) -> Simd4 {
    let magic = Simd4::splat(12582912.0);
    x.add(magic).sub(magic)
}

#[inline]
pub fn wrap_pi4(x: Simd4) -> Simd4 {
    x.sub(Simd4::splat(TWO_PI).mul(round4(x.mul(Simd4::splat(INV_TWO_PI)))))
}

#[inline]
pub fn sqrt4(x: Simd4) -> Simd4 {
    let (half, three_half, zero) = (Simd4::splat(0.5), Simd4::splat(1.5), Simd4::splat(0.0));
    let mut y = x.rsqrt_seed();
    y = y.mul(three_half.sub(half.mul(x).mul(y).mul(y)));
    y = y.mul(three_half.sub(half.mul(x).mul(y).mul(y)));
    Simd4::select(x.gt(zero), x.mul(y), zero)
}

#[inline]
pub fn atan2_4(y: Simd4, x: Simd4) -> Simd4 {
    let zero = Simd4::splat(0.0);
    let (ax, ay) = (x.abs(), y.abs());
    let (hi, lo) = (ax.max(ay), ax.min(ay));
    let a = Simd4::select(hi.gt(zero), lo.div(hi), zero);
    let a2 = a.mul(a);
    let mut poly = Simd4::splat(-0.01172120);
    poly = Simd4::splat(0.05265332).add(a2.mul(poly));
    poly = Simd4::splat(-0.11643287).add(a2.mul(poly));
    poly = Simd4::splat(0.19354346).add(a2.mul(poly));
    poly = Simd4::splat(-0.33262347).add(a2.mul(poly));
    poly = Simd4::splat(0.99997726).add(a2.mul(poly));
    let mut r = a.mul(poly);
    r = Simd4::select(ay.gt(ax), Simd4::splat(HALF_PI).sub(r), r);
    r = Simd4::select(x.lt(zero), Simd4::splat(PI).sub(r), r);
    r = Simd4::select(y.lt(zero), zero.sub(r), r);
    r
}

#[inline]
pub fn sin_cos4(x: Simd4) -> (Simd4, Simd4) {
    let zero = Simd4::splat(0.0);
    let t = x.sub(Simd4::splat(TWO_PI).mul(round4(x.mul(Simd4::splat(INV_TWO_PI)))));
    let reflect = t.abs().gt(Simd4::splat(HALF_PI));
    let sign = Simd4::select(t.ge(zero), Simd4::splat(1.0), Simd4::splat(-1.0));
    let a = Simd4::select(reflect, sign.mul(Simd4::splat(PI)).sub(t), t);
    let cos_sign = Simd4::select(reflect, Simd4::splat(-1.0), Simd4::splat(1.0));
    let a2 = a.mul(a);
    let mut sin_poly = Simd4::splat(0.0000027557319);
    sin_poly = Simd4::splat(-0.00019841270).add(a2.mul(sin_poly));
    sin_poly = Simd4::splat(0.008333333).add(a2.mul(sin_poly));
    sin_poly = Simd4::splat(-0.16666667).add(a2.mul(sin_poly));
    sin_poly = Simd4::splat(1.0).add(a2.mul(sin_poly));
    let mut cos_a = Simd4::splat(-0.00000027557319);
    cos_a = Simd4::splat(0.000024801587).add(a2.mul(cos_a));
    cos_a = Simd4::splat(-0.0013888889).add(a2.mul(cos_a));
    cos_a = Simd4::splat(0.041666668).add(a2.mul(cos_a));
    cos_a = Simd4::splat(-0.5).add(a2.mul(cos_a));
    cos_a = Simd4::splat(1.0).add(a2.mul(cos_a));
    (a.mul(sin_poly), cos_sign.mul(cos_a))
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
    fn sqrt_matches_libm() {
        let mut max = 0.0f32;
        let mut x = 0.0f32;
        while x < 100.0 {
            let a = sqrt(x); let b = libm::sqrtf(x);
            if b > 1e-6 { max = max.max(((a - b) / b).abs()); }
            x += 0.001;
        }
        println!("sqrt max rel err {max:.2e}");
        assert!(max < 1e-4, "sqrt error {max:.2e}");
        assert_eq!(sqrt(0.0), 0.0);
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

    // The 4-wide versions must be BIT-IDENTICAL to the scalar ones per lane (same ops, same order). Since the
    // scalar versions are verified vs libm above, this transitively proves the SIMD accuracy — and the native
    // scalar `Simd4` fallback exercised here is bit-exact to the wasm `f32x4` path (same IEEE-754 single ops).
    #[test]
    fn simd4_round_wrap_sincos_match_scalar() {
        let mut x = -40.0f32;
        while x < 40.0 {
            let xs = [x, x + 0.11, x + 0.53, x + 0.97];
            let v = Simd4::load(&xs);
            let (round, wrap) = (round4(v).to_array(), wrap_pi4(v).to_array());
            let (sin_v, cos_v) = sin_cos4(v);
            let (sins, coss) = (sin_v.to_array(), cos_v.to_array());
            for lane in 0..4 {
                assert_eq!(round[lane], round_f32(xs[lane]), "round lane {lane} @ {}", xs[lane]);
                assert_eq!(wrap[lane], wrap_pi(xs[lane]), "wrap_pi lane {lane} @ {}", xs[lane]);
                let (scalar_sin, scalar_cos) = sin_cos(xs[lane]);
                assert_eq!(sins[lane], scalar_sin, "sin lane {lane} @ {}", xs[lane]);
                assert_eq!(coss[lane], scalar_cos, "cos lane {lane} @ {}", xs[lane]);
            }
            x += 0.37;
        }
    }

    #[test]
    fn simd4_sqrt_matches_scalar() {
        let mut x = 0.0f32;
        while x < 100.0 {
            let xs = [x, x + 0.031, x + 0.057, x + 0.093];
            let root = sqrt4(Simd4::load(&xs)).to_array();
            for lane in 0..4 { assert_eq!(root[lane], sqrt(xs[lane]), "sqrt lane {lane} @ {}", xs[lane]); }
            x += 0.1;
        }
        assert_eq!(sqrt4(Simd4::splat(0.0)).to_array(), [0.0; 4]);
        assert_eq!(sqrt4(Simd4::splat(-1.0)).to_array(), [0.0; 4]);
    }

    #[test]
    fn simd4_atan2_matches_scalar() {
        let mut y = -4.0f32;
        while y < 4.0 {
            let mut x = -4.0f32;
            while x < 4.0 {
                let ys = [y, y + 0.13, y - 0.29, y + 1.7];
                let xs = [x, x - 0.19, x + 0.41, x - 0.83];
                let got = atan2_4(Simd4::load(&ys), Simd4::load(&xs)).to_array();
                for lane in 0..4 {
                    assert_eq!(got[lane], atan2(ys[lane], xs[lane]), "atan2 lane {lane} @ ({},{})", ys[lane], xs[lane]);
                }
                x += 0.37;
            }
            y += 0.37;
        }
    }
}
