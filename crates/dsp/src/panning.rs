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

/// A 2x2 stereo mixing matrix (`L->L`, `R->L`, `L->R`, `R->R`), a port of lib-dsp `StereoMatrix.Matrix`.
#[derive(Clone, Copy, Default)]
pub struct Matrix {
    pub ll: f32,
    pub lr: f32,
    pub rl: f32,
    pub rr: f32
}

/// The stereo-shaping parameters, a port of lib-dsp `StereoMatrix.Params`: `gain` (linear), `panning` (-1..1),
/// `stereo` (-1 fully mono .. +1 widened), channel inverts, and a left/right swap.
#[derive(Clone, Copy, Default)]
pub struct StereoParams {
    pub gain: f32,
    pub panning: f32,
    pub stereo: f32,
    pub invert_l: bool,
    pub invert_r: bool,
    pub swap: bool
}

/// Compute the mixing matrix for `params` under `mixing`, a port of `StereoMatrix.update`. Panning gains scale
/// each channel; `stereo < 0` folds toward mono (mid), `> 0` widens (side); inverts negate a channel; swap
/// exchanges the output channels.
pub fn update_matrix(matrix: &mut Matrix, params: &StereoParams, mixing: Mixing) {
    let [pan_left, pan_right] = panning_to_gains(params.panning, mixing);
    let mut left_gain = pan_left * params.gain;
    let mut right_gain = pan_right * params.gain;
    if params.invert_l {left_gain *= -1.0;}
    if params.invert_r {right_gain *= -1.0;}
    let mono = (-params.stereo).max(0.0);
    let expand = params.stereo.max(0.0);
    let mid_gain = 1.0 - expand;
    let side_gain = 1.0 + expand;
    let mono_amount = mono * 0.5;
    let stereo_width = 1.0 - mono;
    let m00 = (mid_gain + side_gain) * 0.5;
    let m01 = (mid_gain - side_gain) * 0.5;
    let m10 = (mid_gain - side_gain) * 0.5;
    let m11 = (mid_gain + side_gain) * 0.5;
    let ll = (left_gain * (mono_amount + stereo_width)) * m00 + (right_gain * mono_amount) * m01;
    let rl = (left_gain * (mono_amount + stereo_width)) * m10 + (right_gain * mono_amount) * m11;
    let lr = (left_gain * mono_amount) * m00 + (right_gain * (mono_amount + stereo_width)) * m01;
    let rr = (left_gain * mono_amount) * m10 + (right_gain * (mono_amount + stereo_width)) * m11;
    if params.swap {
        matrix.ll = rl;
        matrix.rl = ll;
        matrix.lr = rr;
        matrix.rr = lr;
    } else {
        matrix.ll = ll;
        matrix.lr = lr;
        matrix.rl = rl;
        matrix.rr = rr;
    }
}

#[cfg(test)]
mod tests {
    use super::{panning_to_gains, update_matrix, Matrix, Mixing, StereoParams};

    fn params(gain: f32, panning: f32, stereo: f32) -> StereoParams {
        StereoParams {gain, panning, stereo, invert_l: false, invert_r: false, swap: false}
    }

    #[test]
    fn identity_gain_passes_stereo_through() {
        // gain 1, centre pan, no width change under linear: unity diagonal, no cross-bleed.
        let mut matrix = Matrix::default();
        update_matrix(&mut matrix, &params(1.0, 0.0, 0.0), Mixing::Linear);
        assert!((matrix.ll - 1.0).abs() < 1e-6 && (matrix.rr - 1.0).abs() < 1e-6);
        assert!(matrix.lr.abs() < 1e-6 && matrix.rl.abs() < 1e-6, "no cross-bleed at centre");
    }

    #[test]
    fn full_mono_collapses_both_channels_together() {
        // stereo = -1 -> fully mono: each output is the sum of both inputs at equal weight (no L/R difference).
        let mut matrix = Matrix::default();
        update_matrix(&mut matrix, &params(1.0, 0.0, -1.0), Mixing::Linear);
        assert!((matrix.ll - matrix.rl).abs() < 1e-6, "left output mixes L and R equally");
        assert!((matrix.lr - matrix.rr).abs() < 1e-6, "right output mixes L and R equally");
    }

    #[test]
    fn swap_exchanges_the_output_rows() {
        let mut normal = Matrix::default();
        update_matrix(&mut normal, &params(1.0, 0.3, 0.2), Mixing::EqualPower);
        let mut swapped = Matrix::default();
        let mut swap_params = params(1.0, 0.3, 0.2);
        swap_params.swap = true;
        update_matrix(&mut swapped, &swap_params, Mixing::EqualPower);
        assert_eq!((swapped.ll, swapped.rl), (normal.rl, normal.ll), "swap exchanges the L-output row");
    }

    #[test]
    fn invert_left_negates_the_left_contribution() {
        let mut plain = Matrix::default();
        update_matrix(&mut plain, &params(1.0, 0.0, 0.0), Mixing::Linear);
        let mut inverted = params(1.0, 0.0, 0.0);
        inverted.invert_l = true;
        let mut matrix = Matrix::default();
        update_matrix(&mut matrix, &inverted, Mixing::Linear);
        assert!((matrix.ll + plain.ll).abs() < 1e-6, "left-to-left is negated");
    }

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
