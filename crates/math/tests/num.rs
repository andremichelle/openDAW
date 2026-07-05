//! Math primitives: fabs, the parabolic sine vs std sin, clamp, lerp, the TS-mirroring modulo.

use math::{clamp, fabs, fast_sin, lerp, mod_euclid, PI};

#[test]
fn fabs_basic() {
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

#[test]
fn clamp_bounds() {
    assert_eq!(clamp(5.0, 0.0, 10.0), 5.0);
    assert_eq!(clamp(-1.0, 0.0, 10.0), 0.0);
    assert_eq!(clamp(11.0, 0.0, 10.0), 10.0);
    assert_eq!(clamp(0.0, 0.0, 10.0), 0.0);
    assert_eq!(clamp(10.0, 0.0, 10.0), 10.0);
}

#[test]
fn lerp_endpoints_and_midpoint() {
    assert_eq!(lerp(0.0, 10.0, 0.0), 0.0);
    assert_eq!(lerp(0.0, 10.0, 1.0), 10.0);
    assert_eq!(lerp(0.0, 10.0, 0.5), 5.0);
    assert_eq!(lerp(-4.0, 4.0, 0.25), -2.0);
}

#[test]
fn mod_euclid_mirrors_ts_mod_bit_exactly() {
    // TS lib-std `mod = fract(value / range) * range` rounds through the divided domain: mod(7200, 6240)
    // is 959.9999999999993, NOT 960. A value-region loop wrap reads its curve at this local position, so an
    // update-clock tick landing exactly on a curve event must resolve to the SAME side of the event in both
    // engines (the atstil stutter `enable` flipped one tick early in wasm with an exact modulo).
    assert_eq!(mod_euclid(7200.0, 6240.0), 959.9999999999993);
    assert_eq!(mod_euclid(960.0, 6240.0), 960.0);
    assert_eq!(mod_euclid(0.0, 6240.0), 0.0);
    assert_eq!(mod_euclid(-1.0, 8.0), 7.0, "negative input wraps into [0, m)");
}
