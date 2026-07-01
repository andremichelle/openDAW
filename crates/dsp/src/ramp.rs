//! A linear parameter ramp, a port of lib-dsp `Ramp.LinearRamp`. A control value glides to a new target over
//! a fixed number of samples, so a parameter edit does not click. `f32` (the audio path), mirroring the TS
//! `number` math closely enough for identical audible output. Constructed with a length (`Ramp.linear` rounds
//! `sampleRate * seconds` up); a zeroed instance has length 0, so a device builds it in `init`.

/// A per-sample linear glide toward a target. Mirrors lib-dsp `LinearRamp`.
#[derive(Clone, Copy, Default)]
pub struct LinearRamp {
    length: u32,
    value: f32,
    target: f32,
    delta: f32,
    remaining: u32
}

impl LinearRamp {
    /// A ramp reaching a new target over `ceil(sample_rate * seconds)` samples (min 1). Mirrors
    /// `Ramp.linear(sampleRate, seconds)` (the TS default `seconds` is 0.005).
    pub fn linear(sample_rate: f32, seconds: f32) -> Self {
        let length = (libm::ceilf(sample_rate * seconds) as u32).max(1);
        Self {length, value: 0.0, target: 0.0, delta: 0.0, remaining: 0}
    }

    /// Aim at `target`: `smooth` glides over the ramp length, otherwise it jumps. A no-op if already there
    /// (mirrors the TS early-out, so a redundant set does not restart the glide).
    pub fn set(&mut self, target: f32, smooth: bool) {
        if self.value == target {return}
        if smooth {
            self.target = target;
            self.delta = (target - self.value) / self.length as f32;
            self.remaining = self.length;
        } else {
            self.value = target;
            self.target = target;
            self.delta = 0.0;
            self.remaining = 0;
        }
    }

    /// The current value without advancing (`Ramp.get`).
    pub fn get(&self) -> f32 {
        self.value
    }

    /// Advance one sample toward the target and return the new value (`Ramp.moveAndGet`). Snaps exactly to the
    /// target on the final step so accumulated error never lingers.
    pub fn move_and_get(&mut self) -> f32 {
        if self.remaining > 0 {
            self.value += self.delta;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.delta = 0.0;
                self.value = self.target;
            }
        }
        self.value
    }

    /// Whether a glide is in progress (`Ramp.isInterpolating`).
    pub fn is_interpolating(&self) -> bool {
        self.remaining > 0
    }
}

use crate::panning::{update_matrix, Matrix, Mixing, StereoParams};

/// A ramped 2x2 stereo mixing matrix, a port of lib-dsp `Ramp.StereoMatrixRamp`. On a parameter change the four
/// coefficients glide to a new matrix over the ramp length; `process_frames` applies the (ramping) matrix to a
/// stereo block. Built with a length (`Ramp.stereoMatrix`); a zeroed instance has length 0, so a device builds
/// it in `init`.
#[derive(Clone, Copy, Default)]
pub struct StereoMatrixRamp {
    length: u32,
    value: Matrix,
    target: Matrix,
    delta: Matrix,
    remaining: u32
}

impl StereoMatrixRamp {
    /// A matrix ramp reaching a new target over `ceil(sample_rate * seconds)` samples (min 1). Mirrors
    /// `Ramp.stereoMatrix(sampleRate, seconds)` (the TS default `seconds` is 0.005).
    pub fn stereo_matrix(sample_rate: f32, seconds: f32) -> Self {
        let length = (libm::ceilf(sample_rate * seconds) as u32).max(1);
        Self {length, ..Default::default()}
    }

    /// Recompute the target matrix from `params` / `mixing` and either glide to it (`smooth`) or jump. Mirrors
    /// `StereoMatrixRamp.update` (no equals early-out — the caller gates on its own `needsUpdate`).
    pub fn update(&mut self, params: &StereoParams, mixing: Mixing, smooth: bool) {
        update_matrix(&mut self.target, params, mixing);
        if smooth {
            let length = self.length as f32;
            self.delta.ll = (self.target.ll - self.value.ll) / length;
            self.delta.lr = (self.target.lr - self.value.lr) / length;
            self.delta.rl = (self.target.rl - self.value.rl) / length;
            self.delta.rr = (self.target.rr - self.value.rr) / length;
            self.remaining = self.length;
        } else {
            self.value = self.target;
            self.delta = Matrix::default();
            self.remaining = 0;
        }
    }

    /// Apply the matrix to `[from, to)` of a stereo block. While gliding, the matrix advances per sample;
    /// otherwise the settled target is applied directly. Mirrors `StereoMatrixRamp.processFrames`.
    pub fn process_frames(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        if self.remaining > 0 {
            for i in from..to {
                let (left, right) = (in_left[i], in_right[i]);
                let matrix = self.move_and_get();
                out_left[i] = matrix.ll * left + matrix.rl * right;
                out_right[i] = matrix.lr * left + matrix.rr * right;
            }
        } else {
            let matrix = self.target;
            for i in from..to {
                let (left, right) = (in_left[i], in_right[i]);
                out_left[i] = matrix.ll * left + matrix.rl * right;
                out_right[i] = matrix.lr * left + matrix.rr * right;
            }
        }
    }

    fn move_and_get(&mut self) -> Matrix {
        if self.remaining > 0 {
            self.value.ll += self.delta.ll;
            self.value.lr += self.delta.lr;
            self.value.rl += self.delta.rl;
            self.value.rr += self.delta.rr;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.delta = Matrix::default();
                self.value = self.target;
            }
        }
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::{LinearRamp, StereoMatrixRamp};
    use crate::panning::{Mixing, StereoParams};

    #[test]
    fn an_unsmoothed_set_jumps_immediately() {
        let mut ramp = LinearRamp::linear(48_000.0, 0.005);
        ramp.set(0.75, false);
        assert_eq!(ramp.get(), 0.75);
        assert!(!ramp.is_interpolating());
    }

    #[test]
    fn a_smoothed_set_glides_over_the_length_and_snaps() {
        let mut ramp = LinearRamp::linear(48_000.0, 0.005); // length = 240
        ramp.set(1.0, true);
        assert!(ramp.is_interpolating());
        let first = ramp.move_and_get();
        assert!(first > 0.0 && first < 0.01, "the first step is one length-fraction of the way");
        for _ in 1..240 {ramp.move_and_get();}
        assert!(!ramp.is_interpolating(), "the glide completes after `length` steps");
        assert_eq!(ramp.get(), 1.0, "and lands exactly on the target");
    }

    #[test]
    fn a_redundant_set_does_not_restart_the_glide() {
        let mut ramp = LinearRamp::linear(48_000.0, 0.005);
        ramp.set(0.5, false);
        ramp.set(0.5, true); // already at 0.5 -> no-op
        assert!(!ramp.is_interpolating());
    }

    fn params(gain: f32, panning: f32, stereo: f32) -> StereoParams {
        StereoParams {gain, panning, stereo, invert_l: false, invert_r: false, swap: false}
    }

    #[test]
    fn stereo_matrix_ramp_applies_the_settled_matrix() {
        // An unsmoothed update jumps: a centre, unity, no-width matrix passes the stereo signal through.
        let mut ramp = StereoMatrixRamp::stereo_matrix(48_000.0, 0.005);
        ramp.update(&params(1.0, 0.0, 0.0), Mixing::Linear, false);
        let (in_l, in_r) = ([0.5f32, -0.2], [0.3f32, 0.8]);
        let (mut out_l, mut out_r) = ([0.0f32; 2], [0.0f32; 2]);
        ramp.process_frames(&in_l, &in_r, &mut out_l, &mut out_r, 0, 2);
        assert!((out_l[0] - 0.5).abs() < 1e-6 && (out_r[0] - 0.3).abs() < 1e-6, "pass-through at identity");
    }

    #[test]
    fn stereo_matrix_ramp_glides_between_matrices() {
        // Start at silence (gain 0), glide to unity: the first output samples are attenuated, the settled tail
        // reaches the source level.
        let mut ramp = StereoMatrixRamp::stereo_matrix(48_000.0, 0.005); // length 240
        ramp.update(&params(0.0, 0.0, 0.0), Mixing::Linear, false); // jump to silence
        ramp.update(&params(1.0, 0.0, 0.0), Mixing::Linear, true);  // glide to unity
        let n = 300;
        let (in_l, in_r) = (vec![1.0f32; n], vec![1.0f32; n]);
        let (mut out_l, mut out_r) = (vec![0.0f32; n], vec![0.0f32; n]);
        ramp.process_frames(&in_l, &in_r, &mut out_l, &mut out_r, 0, n);
        assert!(out_l[0] < 0.1, "starts near silence");
        assert!((out_l[n - 1] - 1.0).abs() < 1e-4, "settles at unity after the glide");
    }
}
