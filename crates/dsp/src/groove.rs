//! Groove curves: the per-cell time warps of the groove registry. Mirrors lib-dsp `GrooveCurves`,
//! `GroovePattern` and `QuantisedGrooveFunction` plus the shuffle of `GrooveShuffleBoxAdapter`.
//! A curve maps one cell `[0, 1]` onto itself, monotonic, with `fx` the warp and `fy` its inverse.

const EXPONENT: f64 = 4.0;
const INVERSE_EXPONENT: f64 = 1.0 / EXPONENT;
const BISECT_ITERATIONS: usize = 52;
// WASM CONTRACT: lib-dsp `GrooveCurves.blend` MaxWeight
const MAX_WEIGHT: f64 = 0.98;
// WASM CONTRACT: the adapter's `squashUnit(amount, 0.01)` margin
const SQUASH_MARGIN: f64 = 0.01;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Curve<'a> {
    Power,
    SCurve,
    Table(&'a [f64])
}

/// The shuffle's Moebius ease, `h = 0.5` is the identity (lib-std `moebiusEase`).
pub fn moebius(x: f64, h: f64) -> f64 {
    (x * h) / ((2.0 * h - 1.0) * (x - 1.0) + h)
}

/// lib-std `squashUnit(value, 0.01)`: clamp to the unit interval, then squeeze into `[0.01, 0.99]`.
pub fn squash_unit(value: f64) -> f64 {
    let clamped = if value < 0.0 { 0.0 } else if value > 1.0 { 1.0 } else { value };
    SQUASH_MARGIN + (1.0 - 2.0 * SQUASH_MARGIN) * clamped
}

pub fn curve_fx(curve: Curve, x: f64) -> f64 {
    match curve {
        Curve::Power => 1.0 - math::pow(1.0 - x, EXPONENT),
        Curve::SCurve => if x < 0.5 {
            0.5 - 0.5 * math::pow(1.0 - 2.0 * x, EXPONENT)
        } else {
            0.5 + 0.5 * math::pow(2.0 * x - 1.0, EXPONENT)
        },
        Curve::Table(values) => table_fx(values, x)
    }
}

pub fn curve_fy(curve: Curve, y: f64) -> f64 {
    match curve {
        Curve::Power => 1.0 - math::pow(1.0 - y, INVERSE_EXPONENT),
        Curve::SCurve => if y < 0.5 {
            0.5 - 0.5 * math::pow(1.0 - 2.0 * y, INVERSE_EXPONENT)
        } else {
            0.5 + 0.5 * math::pow(2.0 * y - 1.0, INVERSE_EXPONENT)
        },
        Curve::Table(values) => table_fy(values, y)
    }
}

fn weight_of(amount: f64) -> f64 {
    libm::fabs(2.0 * amount - 1.0).min(1.0) * MAX_WEIGHT
}

fn forward(curve: Curve, weight: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    x + weight * (curve_fx(curve, x) - x)
}

fn inverse(curve: Curve, weight: f64, y: f64) -> f64 {
    if y <= 0.0 {
        return 0.0;
    }
    if y >= 1.0 {
        return 1.0;
    }
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..BISECT_ITERATIONS {
        let middle = (low + high) * 0.5;
        if forward(curve, weight, middle) < y { low = middle } else { high = middle }
    }
    (low + high) * 0.5
}

/// 50% is straight, 100% the curve and 0% its mirror on y = x (lib-dsp `GrooveCurves.blend`)
pub fn blend_fx(curve: Curve, amount: f64, x: f64) -> f64 {
    let weight = weight_of(amount);
    if amount >= 0.5 { forward(curve, weight, x) } else { inverse(curve, weight, x) }
}

pub fn blend_fy(curve: Curve, amount: f64, y: f64) -> f64 {
    let weight = weight_of(amount);
    if amount >= 0.5 { inverse(curve, weight, y) } else { forward(curve, weight, y) }
}

/// One cell of `duration` pulses bent by `transform` on its normalized position. A cell starts at the floored
/// multiple of the duration (lib-dsp `quantizeFloor`), also before zero. A non-positive duration passes through.
pub fn cell<F: Fn(f64) -> f64>(position: f64, duration: f64, transform: F) -> f64 {
    if duration <= 0.0 {
        return position;
    }
    let start = math::floor(position / duration) * duration;
    start + transform((position - start) / duration) * duration
}

/// lib-dsp `GrooveCurves.randomUnit`: the integer hash of the Random modulator, as a unit value.
pub fn random_unit(seed: i32, index: i32) -> f64 {
    let mut hash = seed.wrapping_mul(0x9E3779B1u32 as i32) ^ index.wrapping_mul(0x85EBCA77u32 as i32);
    hash = (hash ^ ((hash as u32) >> 15) as i32).wrapping_mul(0x2545F491u32 as i32);
    hash ^= ((hash as u32) >> 13) as i32;
    (hash as u32) as f64 / 4294967295.0
}

/// The number of entries `fill_random_values` writes for `steps`.
pub fn random_value_count(steps: i32) -> usize {
    steps.max(1) as usize + 1
}

/// lib-dsp `GrooveCurves.randomValues`: a monotonic random sequence from 0 to 1 into `out`
/// (`random_value_count(steps)` entries).
pub fn fill_random_values(seed: i32, steps: i32, roughness: f64, out: &mut [f64]) {
    let count = steps.max(1) as usize;
    let scale = 1.0 + roughness * 15.0;
    out[0] = 0.0;
    let mut sum = 0.0;
    for index in 1..=count {
        let delta = math::floor(random_unit(seed, index as i32) * scale) + 1.0;
        sum += delta;
        out[index] = sum;
    }
    for value in out.iter_mut().take(count).skip(1) {
        *value /= sum;
    }
    out[count] = 1.0;
}

/// lib-dsp `QuantisedGrooveFunction.fx`
pub fn table_fx(values: &[f64], x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let position = x * (values.len() - 1) as f64;
    let index = position as usize;
    let floor = values[index];
    floor + (position - index as f64) * (values[index + 1] - floor)
}

/// lib-dsp `QuantisedGrooveFunction.fy` (`BinarySearch.rightMost`)
pub fn table_fy(values: &[f64], y: f64) -> f64 {
    if y <= 0.0 {
        return 0.0;
    }
    if y >= 1.0 {
        return 1.0;
    }
    let (mut low, mut high) = (0usize, values.len());
    while low < high {
        let middle = (low + high) >> 1;
        if values[middle] <= y { low = middle + 1 } else { high = middle }
    }
    let index = high - 1;
    let current = values[index];
    let next = values[index + 1];
    (index as f64 + (y - current) / (next - current)) / (values.len() - 1) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLES: [f64; 9] = [0.0, 0.05, 0.25, 0.4, 0.5, 0.6, 0.75, 0.95, 1.0];
    const AMOUNTS: [f64; 7] = [0.0, 0.1, 0.4, 0.5, 0.6, 0.9, 1.0];

    #[test]
    fn curves_and_their_inverses() {
        for curve in [Curve::Power, Curve::SCurve] {
            for x in SAMPLES {
                assert!((curve_fy(curve, curve_fx(curve, x)) - x).abs() < 1.0e-9);
            }
        }
        assert!(curve_fx(Curve::Power, 0.5) > 0.5, "power pushes later");
        assert!(curve_fx(Curve::SCurve, 0.25) > 0.25 && curve_fx(Curve::SCurve, 0.75) < 0.75, "s-curve pulls to the middle");
    }

    #[test]
    fn blends_are_monotonic_keep_endpoints_and_invert() {
        let mut values = [0.0; 9];
        fill_random_values(11, 8, 1.0, &mut values);
        for curve in [Curve::Power, Curve::SCurve, Curve::Table(&values)] {
            for amount in AMOUNTS {
                let mut previous = -1.0;
                for index in 0..=100 {
                    let x = index as f64 / 100.0;
                    let y = blend_fx(curve, amount, x);
                    assert!(y >= previous);
                    previous = y;
                    assert!((blend_fx(curve, amount, blend_fy(curve, amount, x)) - x).abs() < 1.0e-3);
                }
                assert_eq!(blend_fx(curve, amount, 0.0), 0.0);
                assert_eq!(blend_fx(curve, amount, 1.0), 1.0);
            }
            for x in SAMPLES {
                assert!((blend_fx(curve, 0.5, x) - x).abs() < 1.0e-12, "50% is straight");
            }
        }
    }

    #[test]
    fn random_values_match_lib_dsp() {
        // GrooveCurves.randomValues(7, 4, 0.5) in TS
        let mut values = [0.0; 5];
        fill_random_values(7, 4, 0.5, &mut values);
        assert_eq!(values[0], 0.0);
        assert_eq!(values[4], 1.0);
        for index in 1..5 {
            assert!(values[index] > values[index - 1]);
        }
        let mut straight = [0.0; 5];
        fill_random_values(3, 4, 0.0, &mut straight);
        assert_eq!(straight, [0.0, 0.25, 0.5, 0.75, 1.0]);
        assert_eq!(random_unit(1, 1), {
            let hash = 1i32.wrapping_mul(0x9E3779B1u32 as i32) ^ 1i32.wrapping_mul(0x85EBCA77u32 as i32);
            let hash = (hash ^ ((hash as u32) >> 15) as i32).wrapping_mul(0x2545F491u32 as i32);
            ((hash ^ ((hash as u32) >> 13) as i32) as u32) as f64 / 4294967295.0
        });
    }

    #[test]
    fn parity_with_lib_dsp() {
        // values printed by lib-dsp GrooveCurves
        let mut a = [0.0; 5];
        fill_random_values(7, 4, 0.5, &mut a);
        assert_eq!(a, [0.0, 0.16666666666666666, 0.5, 0.8333333333333334, 1.0]);
        let mut b = [0.0; 9];
        fill_random_values(123456, 8, 0.8125, &mut b);
        assert_eq!(b, [0.0, 0.05333333333333334, 0.2, 0.3466666666666667, 0.5066666666666667, 0.6533333333333333,
            0.8133333333333334, 0.92, 1.0]);
        assert!((blend_fx(Curve::SCurve, 0.8, 0.3) - 0.41007360000000004).abs() < 1.0e-15);
        assert!((blend_fy(Curve::Power, 0.2, 0.7) - 0.8716372).abs() < 1.0e-12);
        assert!((blend_fx(Curve::Power, 0.2, 0.7) - 0.42637134059686843).abs() < 1.0e-12);
    }

    #[test]
    fn round_trips_stay_exact_next_to_a_cell_edge() {
        for curve in [Curve::Power, Curve::SCurve] {
            for amount in [0.0, 0.001, 0.999, 1.0] {
                for y in [1.0e-12, 1.0e-9, 1.0e-6, 0.5 - 1.0e-9, 0.5 + 1.0e-9, 1.0 - 1.0e-6, 1.0 - 1.0e-9, 1.0 - 1.0e-12] {
                    assert!((blend_fx(curve, amount, blend_fy(curve, amount, y)) - y).abs() < 1.0e-12);
                    assert!((blend_fy(curve, amount, blend_fx(curve, amount, y)) - y).abs() < 1.0e-12);
                }
            }
        }
    }

    #[test]
    fn table_inverse() {
        let values = [0.0, 0.1, 0.5, 0.6, 1.0];
        for x in SAMPLES {
            assert!((table_fy(&values, table_fx(&values, x)) - x).abs() < 1.0e-12);
        }
    }

    #[test]
    fn cells_keep_their_downbeats() {
        let shuffle = |x: f64| moebius(x, squash_unit(0.6));
        for start in [0.0, 480.0, 960.0] {
            assert!((cell(start, 480.0, shuffle) - start).abs() < 1.0e-9);
        }
        assert_eq!(cell(123.0, 0.0, shuffle), 123.0);
        assert!((cell(-480.0, 480.0, shuffle) + 480.0).abs() < 1.0e-9, "a cell before zero starts at its floor");
        let before = cell(-240.0, 480.0, shuffle);
        assert!(before > -480.0 && before < 0.0, "a position before zero stays in its own cell");
    }
}
