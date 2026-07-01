//! Waveshaping transfer functions, a port of lib-dsp `Waveshaper`. Each equation maps one sample through a
//! non-linearity; `process` shapes a stereo block in place. `f32` (the audio path), mirroring the TS `number`
//! math. https://www.desmos.com/calculator/04tpdtpkfy

use core::f32::consts::PI;

/// The transfer functions, in the TS declaration order (`Waveshaper.Equations`) — the `equation` string field
/// resolves to one of these by name.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum Equation {
    #[default]
    HardClip,
    CubicSoft,
    Tanh,
    Sigmoid,
    Arctan,
    Asymmetric
}

impl Equation {
    /// Resolve the box's `equation` string field. An empty / unknown string falls back to `Tanh`, mirroring the
    /// TS processor (`value === "" ? "tanh" : value`).
    pub fn from_name(name: &str) -> Self {
        match name {
            "hardclip" => Equation::HardClip,
            "cubicSoft" => Equation::CubicSoft,
            "tanh" => Equation::Tanh,
            "sigmoid" => Equation::Sigmoid,
            "arctan" => Equation::Arctan,
            "asymmetric" => Equation::Asymmetric,
            _ => Equation::Tanh
        }
    }

    /// Map one sample through the transfer function. Mirrors `Waveshaper.apply`.
    #[inline]
    pub fn apply(self, x: f32) -> f32 {
        match self {
            Equation::HardClip => x.clamp(-1.0, 1.0),
            Equation::CubicSoft => {
                let cx = x.clamp(-1.0, 1.0);
                (3.0 * cx - cx * cx * cx) * 0.5
            }
            Equation::Tanh => libm::tanhf(x),
            Equation::Sigmoid => sign(x) * (1.0 - libm::expf(-libm::fabsf(x))),
            Equation::Arctan => (2.0 / PI) * libm::atanf(x),
            Equation::Asymmetric => {
                if x >= 0.0 {
                    x / (1.0 + x)
                } else if x < -1.0 {
                    -1.0
                } else if x < -2.0 / 3.0 {
                    let t = 3.0 * (x + 1.0);
                    t * t * (2.0 - t) / 3.0 - 1.0
                } else {
                    x
                }
            }
        }
    }
}

/// Shape a stereo block in place over `[from, to)`. Mirrors `Waveshaper.process`.
pub fn process(left: &mut [f32], right: &mut [f32], equation: Equation, from: usize, to: usize) {
    for sample in from..to {
        left[sample] = equation.apply(left[sample]);
        right[sample] = equation.apply(right[sample]);
    }
}

/// `Math.sign`: -1 / 0 / +1. (`f32::signum` returns ±1 for zero, which would differ from the TS `sign`.)
#[inline]
fn sign(x: f32) -> f32 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::{process, Equation};

    #[test]
    fn names_resolve_and_unknown_falls_back_to_tanh() {
        assert_eq!(Equation::from_name("hardclip"), Equation::HardClip);
        assert_eq!(Equation::from_name("asymmetric"), Equation::Asymmetric);
        assert_eq!(Equation::from_name(""), Equation::Tanh);
        assert_eq!(Equation::from_name("nonsense"), Equation::Tanh);
    }

    #[test]
    fn hardclip_clamps_to_unit_range() {
        assert_eq!(Equation::HardClip.apply(2.0), 1.0);
        assert_eq!(Equation::HardClip.apply(-2.0), -1.0);
        assert_eq!(Equation::HardClip.apply(0.5), 0.5);
    }

    #[test]
    fn tanh_is_odd_and_saturates() {
        let big = Equation::Tanh.apply(10.0);
        assert!(big > 0.999, "saturates toward +1");
        assert!((Equation::Tanh.apply(-0.3) + Equation::Tanh.apply(0.3)).abs() < 1e-6, "odd symmetry");
    }

    #[test]
    fn arctan_is_bounded_by_one() {
        assert!(Equation::Arctan.apply(1e6) < 1.0 && Equation::Arctan.apply(1e6) > 0.999);
    }

    #[test]
    fn asymmetric_treats_positive_and_negative_differently() {
        let pos = Equation::Asymmetric.apply(1.0); // 1/(1+1) = 0.5
        assert!((pos - 0.5).abs() < 1e-6);
        assert_eq!(Equation::Asymmetric.apply(-2.0), -1.0); // clamps the far-negative tail
        assert!((Equation::Asymmetric.apply(-0.5) - (-0.5)).abs() < 1e-6); // linear in the near-negative region
    }

    #[test]
    fn process_shapes_a_stereo_block_in_place() {
        let mut left = [2.0f32, -2.0, 0.25];
        let mut right = [-3.0f32, 0.5, 4.0];
        process(&mut left, &mut right, Equation::HardClip, 0, 3);
        assert_eq!(left, [1.0, -1.0, 0.25]);
        assert_eq!(right, [-1.0, 0.5, 1.0]);
    }

    #[test]
    fn process_respects_the_range_bounds() {
        let mut left = [2.0f32, 2.0, 2.0];
        let mut right = [2.0f32, 2.0, 2.0];
        process(&mut left, &mut right, Equation::HardClip, 1, 2); // only index 1
        assert_eq!(left, [2.0, 1.0, 2.0]);
        assert_eq!(right, [2.0, 1.0, 2.0]);
    }
}
