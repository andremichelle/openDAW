//! Curve math: endpoints, linearity at slope 0.5, concave/convex shaping, inverse round-trip, and
//! the recurrence coefficients reproducing the curve at integer steps.

use math::curve;

const EPS: f32 = 1e-4;

#[test]
fn normalized_endpoints_are_fixed_for_any_slope() {
    for slope in [0.1, 0.3, 0.5, 0.7, 0.9] {
        assert!((curve::normalized_at(0.0, slope) - 0.0).abs() < EPS, "f(0) at slope {slope}");
        assert!((curve::normalized_at(1.0, slope) - 1.0).abs() < EPS, "f(1) at slope {slope}");
    }
}

#[test]
fn slope_half_is_identity() {
    for x in [0.0, 0.25, 0.5, 0.75, 1.0] {
        assert!((curve::normalized_at(x, 0.5) - x).abs() < EPS, "linear at x {x}");
    }
}

#[test]
fn concave_below_convex_above_at_midpoint() {
    assert!(curve::normalized_at(0.5, 0.3) < 0.5, "slope < 0.5 is below the diagonal");
    assert!(curve::normalized_at(0.5, 0.7) > 0.5, "slope > 0.5 is above the diagonal");
}

#[test]
fn normalized_is_monotonic_increasing() {
    for slope in [0.2, 0.5, 0.8] {
        let mut previous = curve::normalized_at(0.0, slope);
        for step in 1..=100 {
            let current = curve::normalized_at(step as f32 / 100.0, slope);
            assert!(current >= previous - EPS, "monotonic at slope {slope}, step {step}");
            previous = current;
        }
    }
}

#[test]
fn value_at_maps_endpoints_to_y0_y1() {
    let (slope, steps, y0, y1) = (0.3, 960.0, 100.0, 140.0);
    assert!((curve::value_at(slope, steps, y0, y1, 0.0) - y0).abs() < 1e-3, "x=0 -> y0");
    assert!((curve::value_at(slope, steps, y0, y1, steps) - y1).abs() < 1e-3, "x=steps -> y1");
}

#[test]
fn value_at_linear_is_a_straight_line() {
    let (steps, y0, y1) = (10.0, 0.0, 100.0);
    for x in [0.0, 2.5, 5.0, 7.5, 10.0] {
        let expected = y0 + (x / steps) * (y1 - y0);
        assert!((curve::value_at(0.5, steps, y0, y1, x) - expected).abs() < EPS, "linear at x {x}");
    }
}

#[test]
fn inverse_round_trips_normalized() {
    for slope in [0.2, 0.35, 0.65, 0.8] {
        for x in [0.1, 0.4, 0.6, 0.9] {
            let y = curve::normalized_at(x, slope);
            assert!((curve::inverse_at(y, slope) - x).abs() < 2e-3, "inverse at slope {slope}, x {x}");
        }
    }
}

#[test]
fn recurrence_reproduces_curve_at_integer_steps() {
    let (slope, steps, y0, y1) = (0.25, 8.0, 50.0, 90.0);
    let (m, q) = curve::coefficients(slope, steps, y0, y1);
    let mut value = y0;
    for step in 1..=(steps as i32) {
        value = m * value + q;
        let direct = curve::value_at(slope, steps, y0, y1, step as f32);
        assert!((value - direct).abs() < 1e-2, "recurrence vs direct at step {step}");
    }
}

#[test]
fn slope_by_half_recovers_midpoint() {
    assert!((curve::slope_by_half(0.0, 5.0, 10.0) - 0.5).abs() < EPS, "midpoint is linear");
    assert!((curve::slope_by_half(0.0, 2.0, 10.0) - 0.2).abs() < EPS, "below midpoint");
    assert!((curve::slope_by_half(0.0, 8.0, 10.0) - 0.8).abs() < EPS, "above midpoint");
    assert!((curve::slope_by_half(5.0, 5.0, 5.0) - 0.5).abs() < EPS, "flat segment is linear");
}
