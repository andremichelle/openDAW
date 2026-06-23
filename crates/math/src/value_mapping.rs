//! Value mappings: uniform 0..1 <-> a parameter's real value, a port of lib-std `value-mapping.ts`. Like TS
//! `ValueMapping<Y>`, the trait is GENERIC over the real output type `Y`, so each mapping yields its own
//! type — `Linear`/`Exponential` -> `f32`, `LinearInteger` -> `i32`, `Bool` -> `bool` — not a flattened
//! float. A device declares a mapping for a parameter and uses `y(unit)` to turn an automation curve (always
//! 0..1) into the real value, and `x(value)` for the inverse.

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

#[cfg(test)]
mod tests {
    use super::{Bool, Exponential, Linear, LinearInteger, ValueMapping};

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
}
