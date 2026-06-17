//! Math primitives: fabs, the parabolic sine vs std sin, clamp, lerp.

use math::{clamp, fabs, fast_sin, lerp, PI};

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
