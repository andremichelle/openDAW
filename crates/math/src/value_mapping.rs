//! Value mappings: uniform 0..1 <-> a parameter's real value, a port of lib-std `value-mapping.ts`. Like TS
//! `ValueMapping<Y>`, the trait is GENERIC over the real output type `Y`, so each mapping yields its own type,
//! never a flattened float: `Linear` / `Exponential` / `Power` / `Decibel` -> `f32`, `LinearInteger` -> `i32`,
//! `Bool` -> `bool`, `Values<T>` -> `T`. A device declares a mapping for a parameter and uses `y(unit)` to
//! turn an automation curve (always 0..1) into the real value, and `x(value)` for the inverse. The full TS
//! set is covered: `Linear` (with `unipolar`/`bipolar`), `LinearInteger`, `Exponential`, `Power` (with
//! `by_center`), `Decibel` (volume/gain), `Values`, and `Bool`.

use crate::{clamp, exp_lerp, lerp};

/// Maps the uniform unit interval to a real value of type `Y` and back. Mirrors lib-std `ValueMapping<Y>`.
pub trait ValueMapping<Y> {
    /// The real value for a uniform `x` in 0..1.
    fn y(&self, x: f32) -> Y;
    /// The uniform 0..1 for a real value `y`.
    fn x(&self, y: Y) -> f32;
}

/// A linear `f32` range.
#[derive(Clone, Copy)]
pub struct Linear {
    pub min: f32,
    pub max: f32
}

impl Linear {
    /// The `0..1` unit range (TS `ValueMapping.unipolar`).
    pub const fn unipolar() -> Self {
        Self {min: 0.0, max: 1.0}
    }

    /// The `-1..1` bipolar range (TS `ValueMapping.bipolar`).
    pub const fn bipolar() -> Self {
        Self {min: -1.0, max: 1.0}
    }
}

impl ValueMapping<f32> for Linear {
    fn y(&self, x: f32) -> f32 {
        lerp(self.min, self.max, clamp(x, 0.0, 1.0))
    }

    fn x(&self, y: f32) -> f32 {
        clamp((y - self.min) / (self.max - self.min), 0.0, 1.0)
    }
}

/// A linear INTEGER range: `y` rounds to a whole `i32`.
#[derive(Clone, Copy)]
pub struct LinearInteger {
    pub min: i32,
    pub max: i32
}

impl ValueMapping<i32> for LinearInteger {
    fn y(&self, x: f32) -> i32 {
        self.min + libm::roundf(clamp(x, 0.0, 1.0) * (self.max - self.min) as f32) as i32
    }

    fn x(&self, y: i32) -> f32 {
        clamp((y - self.min) as f32 / (self.max - self.min) as f32, 0.0, 1.0)
    }
}

/// An exponential (geometric) `f32` range; `min`/`max` must be > 0.
#[derive(Clone, Copy)]
pub struct Exponential {
    pub min: f32,
    pub max: f32
}

impl ValueMapping<f32> for Exponential {
    fn y(&self, x: f32) -> f32 {
        exp_lerp(self.min, self.max, clamp(x, 0.0, 1.0))
    }

    fn x(&self, y: f32) -> f32 {
        if y <= self.min {
            0.0
        } else if y >= self.max {
            1.0
        } else {
            libm::logf(y / self.min) / libm::logf(self.max / self.min)
        }
    }
}

/// A power-curve `f32` range: `y = min + x^exp * (max - min)`. `exp > 1` packs resolution near `min`,
/// `exp < 1` near `max`. Construct directly with a known exponent, or with [`Power::by_center`] to place a
/// chosen value at the halfway point.
#[derive(Clone, Copy)]
pub struct Power {
    pub exp: f32,
    pub min: f32,
    pub max: f32
}

impl Power {
    /// A power curve whose `y(0.5)` equals `center` (TS `ValueMapping.powerByCenter`). Not `const` (it takes a
    /// log); a device computes it once at init, or uses a literal `Power { exp, .. }` when the exponent is known.
    pub fn by_center(center: f32, min: f32, max: f32) -> Self {
        let exp = libm::logf((max - min) / (center - min)) / libm::logf(2.0);
        Self {exp, min, max}
    }
}

impl ValueMapping<f32> for Power {
    fn y(&self, x: f32) -> f32 {
        if x <= 0.0 {
            self.min
        } else if x >= 1.0 {
            self.max
        } else {
            self.min + libm::powf(x, self.exp) * (self.max - self.min)
        }
    }

    fn x(&self, y: f32) -> f32 {
        if y <= self.min {
            0.0
        } else if y >= self.max {
            1.0
        } else {
            libm::powf((y - self.min) / (self.max - self.min), 1.0 / self.exp)
        }
    }
}

/// A boolean: `y` is true at or above the halfway point.
#[derive(Clone, Copy)]
pub struct Bool;

impl ValueMapping<bool> for Bool {
    fn y(&self, x: f32) -> bool {
        x >= 0.5
    }

    fn x(&self, y: bool) -> f32 {
        if y {1.0} else {0.0}
    }
}

/// A decibel (volume / gain) range with a chosen `mid` dB at the halfway point, a port of TS `Decibel`. The
/// `a`/`b`/`c` coefficients fit a `a - b / (x + c)` curve through `(0, -inf) .. (0.5, mid) .. (1, max)`, so a
/// fader feels right across its travel. The default volume mapping is `Decibel::new(-72.0, -12.0, 0.0)`.
#[derive(Clone, Copy)]
pub struct Decibel {
    min: f32,
    max: f32,
    a: f32,
    b: f32,
    c: f32
}

impl Decibel {
    /// The default volume mapping, TS `ValueMapping.DefaultDecibel` = `decibel(-72, -12, 0)`.
    pub const fn default_volume() -> Self {
        Self::new(-72.0, -12.0, 0.0)
    }

    /// `min` is the lowest dB, `mid` the dB at the halfway point, `max` the highest. `const` so a device can
    /// declare it as a `const` parameter mapping (the coefficients fold at compile time).
    pub const fn new(min: f32, mid: f32, max: f32) -> Self {
        let min2 = min * min;
        let max2 = max * max;
        let mid2 = mid * mid;
        let tmp0 = min + max - 2.0 * mid;
        let tmp1 = max - mid;
        let a = ((2.0 * max - mid) * min - mid * max) / tmp0;
        let b = (tmp1 * min2 + (mid2 - max2) * min + mid * max2 - mid2 * max)
            / (min2 + (2.0 * max - 4.0 * mid) * min + max2 - 4.0 * mid * max + 4.0 * mid2);
        let c = -tmp1 / tmp0;
        Self {min, max, a, b, c}
    }
}

impl ValueMapping<f32> for Decibel {
    fn y(&self, x: f32) -> f32 {
        if x <= 0.0 {
            f32::NEG_INFINITY
        } else if x >= 1.0 {
            self.max
        } else {
            self.a - self.b / (x + self.c)
        }
    }

    fn x(&self, y: f32) -> f32 {
        if y <= self.min {
            0.0
        } else if y >= self.max {
            1.0
        } else {
            -self.b / (y - self.a) - self.c
        }
    }
}

/// A discrete set: `y` snaps the unit interval to one of `values` (the closest by index), `x` is its index
/// over `len - 1`, a port of TS `Values<T>`. Holds a borrowed slice so a device declares the set as a `const`
/// / `static` array (e.g. selectable waveforms or unison voice counts) and the mapping over it.
#[derive(Clone, Copy)]
pub struct Values<'a, T> {
    pub values: &'a [T]
}

impl<'a, T> Values<'a, T> {
    pub const fn new(values: &'a [T]) -> Self {
        Self {values}
    }
}

impl<'a, T: Copy + PartialEq> ValueMapping<T> for Values<'a, T> {
    fn y(&self, x: f32) -> T {
        let last = self.values.len() - 1;
        let index = (libm::roundf(clamp(x, 0.0, 1.0) * last as f32) as usize).min(last);
        self.values[index]
    }

    fn x(&self, y: T) -> f32 {
        match self.values.iter().position(|value| *value == y) {
            Some(index) => index as f32 / (self.values.len() - 1) as f32,
            None => 0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Bool, Decibel, Exponential, Linear, LinearInteger, Power, Values, ValueMapping};

    #[test]
    fn linear_maps_endpoints_and_midpoint_as_f32() {
        let mapping = Linear {min: 80.0, max: 1120.0};
        assert_eq!(mapping.y(0.0), 80.0);
        assert_eq!(mapping.y(1.0), 1120.0);
        assert_eq!(mapping.y(0.5), 600.0);
    }

    #[test]
    fn linear_integer_yields_an_i32() {
        let mapping = LinearInteger {min: 0, max: 12};
        let twelve: i32 = mapping.y(1.0);
        assert_eq!(twelve, 12);
        assert_eq!(mapping.y(0.0), 0);
        assert_eq!(mapping.y(0.5), 6);
        assert_eq!(mapping.y(0.51), 6, "rounds to the nearest");
        assert!((mapping.x(6) - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn exponential_is_geometric_f32() {
        let mapping = Exponential {min: 80.0, max: 1120.0};
        assert_eq!(mapping.y(0.0), 80.0);
        assert!((mapping.y(1.0) - 1120.0).abs() < 1.0e-2);
        let geometric_mean = (80.0f32 * 1120.0).sqrt();
        assert!((mapping.y(0.5) - geometric_mean).abs() < 0.5);
        assert!((mapping.x(mapping.y(0.3)) - 0.3).abs() < 1.0e-4, "x inverts y");
    }

    #[test]
    fn bool_yields_a_bool() {
        let yes: bool = Bool.y(0.5);
        let no: bool = Bool.y(0.49);
        assert!(yes);
        assert!(!no);
        assert_eq!(Bool.x(true), 1.0);
        assert_eq!(Bool.x(false), 0.0);
    }

    #[test]
    fn linear_unipolar_and_bipolar_helpers() {
        assert_eq!(Linear::unipolar().y(0.0), 0.0);
        assert_eq!(Linear::unipolar().y(1.0), 1.0);
        assert_eq!(Linear::bipolar().y(0.5), 0.0);
        assert_eq!(Linear::bipolar().y(0.0), -1.0);
        assert_eq!(Linear::bipolar().y(1.0), 1.0);
    }

    #[test]
    fn power_curves_and_inverts() {
        let mapping = Power {exp: 2.0, min: 0.0, max: 100.0};
        assert_eq!(mapping.y(0.0), 0.0);
        assert_eq!(mapping.y(1.0), 100.0);
        assert_eq!(mapping.y(0.5), 25.0, "x^2 packs resolution near min");
        assert!((mapping.x(25.0) - 0.5).abs() < 1.0e-6, "x inverts y");
    }

    #[test]
    fn power_by_center_places_the_center_at_the_midpoint() {
        let mapping = Power::by_center(100.0, 0.0, 1000.0);
        assert!((mapping.y(0.5) - 100.0).abs() < 1.0e-2, "the center sits at the halfway point");
        assert_eq!(mapping.y(0.0), 0.0);
        assert!((mapping.y(1.0) - 1000.0).abs() < 1.0e-2);
    }

    #[test]
    fn decibel_volume_mapping_matches_ts_shape() {
        // The default volume mapping: -inf at the bottom, the mid dB at the centre, the max dB at the top.
        let mapping = Decibel::default_volume();
        assert_eq!(mapping.y(0.0), f32::NEG_INFINITY);
        assert_eq!(mapping.y(1.0), 0.0);
        assert!((mapping.y(0.5) - (-12.0)).abs() < 1.0e-3, "the mid dB is at the halfway point");
        assert!((mapping.x(-12.0) - 0.5).abs() < 1.0e-3, "x inverts y at the centre");
        assert_eq!(mapping.x(-72.0), 0.0);
        assert_eq!(mapping.x(0.0), 1.0);
    }

    #[test]
    fn values_snaps_to_a_discrete_set() {
        const WAVEFORMS: [u32; 4] = [10, 20, 30, 40];
        let mapping = Values::new(&WAVEFORMS);
        assert_eq!(mapping.y(0.0), 10);
        assert_eq!(mapping.y(1.0), 40);
        assert_eq!(mapping.y(0.5), 30, "0.5 * 3 = 1.5 rounds to index 2");
        assert_eq!(mapping.y(0.34), 20, "snaps to the nearest member");
        assert!((mapping.x(30) - 2.0 / 3.0).abs() < 1.0e-6);
    }
}
