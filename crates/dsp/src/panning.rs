//! Stereo panning, a port of lib-dsp `StereoMatrix.panningToGains` + the `Mixing` enum. Maps a pan position
//! (-1 left .. +1 right) to a `[left, right]` gain pair under one of two laws. Generic, shareable.

use core::f32::consts::FRAC_PI_4;
use math::clamp;

/// The pan law, mirroring lib-dsp `Mixing` (Linear = 0, EqualPower = 1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mixing {
    Linear,
    EqualPower
}

/// The `[left, right]` gains for a `panning` in `-1..1` under `mixing`. Linear is the constant-sum law (a
/// centred mono source stays unity on both sides); EqualPower is the constant-power cosine/sine law.
pub fn panning_to_gains(panning: f32, mixing: Mixing) -> [f32; 2] {
    let x = clamp(panning, -1.0, 1.0);
    match mixing {
        Mixing::Linear => [(1.0 - x).min(1.0), (x + 1.0).min(1.0)],
        Mixing::EqualPower => {
            let angle = (x + 1.0) * FRAC_PI_4;
            [libm::cosf(angle), libm::sinf(angle)]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{panning_to_gains, Mixing};

    #[test]
    fn linear_is_unity_at_center_and_hard_at_the_sides() {
        assert_eq!(panning_to_gains(0.0, Mixing::Linear), [1.0, 1.0], "centre keeps both channels");
        assert_eq!(panning_to_gains(-1.0, Mixing::Linear), [1.0, 0.0], "hard left silences the right");
        assert_eq!(panning_to_gains(1.0, Mixing::Linear), [0.0, 1.0], "hard right silences the left");
    }

    #[test]
    fn equal_power_holds_constant_power() {
        let [left, right] = panning_to_gains(0.0, Mixing::EqualPower);
        assert!((left - right).abs() < 1.0e-6, "centre is symmetric");
        assert!((left * left + right * right - 1.0).abs() < 1.0e-5, "power sums to one at centre");
        let [hard_left, hard_right] = panning_to_gains(-1.0, Mixing::EqualPower);
        assert!((hard_left - 1.0).abs() < 1.0e-5 && hard_right.abs() < 1.0e-5, "hard left is all left");
    }
}
