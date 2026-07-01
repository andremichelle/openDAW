#![allow(clippy::excessive_precision)]
//! A 2x / 4x / 8x oversampling resampler, a port of lib-dsp `Resampler` (a polyphase halfband up/downsampler).
//! An effect upsamples its input, does its non-linear DSP at the higher rate, then downsamples back — the extra
//! headroom pushes aliasing above the audible band. `f32`, mirroring the TS. Fixed buffers (no allocation): a
//! render quantum is 128 samples, so the oversampled length is at most `128 * 8 = 1024`; the intermediate
//! stage buffers are `256` and `512`.

use crate::RENDER_QUANTUM;

// Normalised halfband filter coefficients (31 taps; sum to 1.0 for DC preservation). Mirrors `HALFBAND_COEFF`;
// used FULL for downsampling.
const HALFBAND_COEFF: [f32; 31] = [
    -0.00048076361, 0.0, 0.00174689293, 0.0, -0.00421638042, 0.0, 0.00854519755, 0.0,
    -0.01627072692, 0.0, 0.03203375191, 0.0, -0.08251235634, 0.0, 0.31203505397, 0.5,
    0.31203505397, 0.0, -0.08251235634, 0.0, 0.03203375191, 0.0, -0.01627072692, 0.0,
    0.00854519755, 0.0, -0.00421638042, 0.0, 0.00174689293, 0.0, -0.00048076361
];
// The polyphase upsampling taps. The TS fills undersized `Float32Array(12)` / `(11)` from the even / odd
// halfband taps, and JS SILENTLY DROPS the overflow — so only the FIRST 12 even and 11 odd taps are used (the
// tail is discarded). We replicate that truncation exactly so the oversampled signal matches the TS audibly.
const PHASE0_COEFF: [f32; 12] = [
    -0.00048076361, 0.00174689293, -0.00421638042, 0.00854519755, -0.01627072692, 0.03203375191,
    -0.08251235634, 0.31203505397, 0.31203505397, -0.08251235634, 0.03203375191, -0.01627072692
];
const PHASE1_COEFF: [f32; 11] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0];

const UP_BUFFER_SIZE: usize = 16;
const UP_BUFFER_MASK: usize = UP_BUFFER_SIZE - 1;
const DOWN_BUFFER_SIZE: usize = 32;
const DOWN_BUFFER_MASK: usize = DOWN_BUFFER_SIZE - 1;

/// One 2x halfband stage (mirrors `Resampler2xMono`): a polyphase upsampler and a decimating downsampler, each
/// with its own ring buffer.
#[derive(Clone, Copy)]
struct Resampler2xMono {
    up_buffer: [f32; UP_BUFFER_SIZE],
    down_buffer: [f32; DOWN_BUFFER_SIZE],
    up_index: usize,
    down_index: usize
}

impl Resampler2xMono {
    const fn new() -> Self {
        Self {up_buffer: [0.0; UP_BUFFER_SIZE], down_buffer: [0.0; DOWN_BUFFER_SIZE], up_index: 0, down_index: 0}
    }

    fn reset(&mut self) {
        self.up_buffer = [0.0; UP_BUFFER_SIZE];
        self.down_buffer = [0.0; DOWN_BUFFER_SIZE];
        self.up_index = 0;
        self.down_index = 0;
    }

    fn upsample(&mut self, input: &[f32], output: &mut [f32], from: usize, to: usize) {
        let mut up_index = self.up_index;
        for i in from..to {
            self.up_buffer[up_index] = input[i];
            let out_idx = (i - from) * 2;
            let mut sum0 = 0.0f32;
            for (j, coeff) in PHASE0_COEFF.iter().enumerate() {
                sum0 += self.up_buffer[(up_index.wrapping_sub(j)) & UP_BUFFER_MASK] * coeff;
            }
            output[out_idx] = sum0 * 2.0;
            let mut sum1 = 0.0f32;
            for (j, coeff) in PHASE1_COEFF.iter().enumerate() {
                sum1 += self.up_buffer[(up_index.wrapping_sub(j).wrapping_sub(1)) & UP_BUFFER_MASK] * coeff;
            }
            output[out_idx + 1] = sum1 * 2.0;
            up_index = (up_index + 1) & UP_BUFFER_MASK;
        }
        self.up_index = up_index;
    }

    fn downsample(&mut self, input: &[f32], output: &mut [f32], from: usize, to: usize) {
        let mut down_index = self.down_index;
        for i in from..to {
            let in_idx = (i - from) * 2;
            self.down_buffer[down_index] = input[in_idx];
            down_index = (down_index + 1) & DOWN_BUFFER_MASK;
            self.down_buffer[down_index] = input[in_idx + 1];
            down_index = (down_index + 1) & DOWN_BUFFER_MASK;
            let mut sum = 0.0f32;
            for (j, coeff) in HALFBAND_COEFF.iter().enumerate() {
                sum += self.down_buffer[(down_index.wrapping_sub(1).wrapping_sub(j)) & DOWN_BUFFER_MASK] * coeff;
            }
            output[i] = sum;
        }
        self.down_index = down_index;
    }
}

/// A multi-stage mono oversampler cascading 1/2/3 halfband `2x` stages for factor 2/4/8. Mirrors `ResamplerMono`
/// but with fixed intermediate buffers. The per-factor sequencing is explicit (not a dynamic loop) so the
/// distinct input / buffer / output regions borrow cleanly.
pub struct ResamplerMono {
    factor: usize,
    stages: [Resampler2xMono; 3],
    buffer0: [f32; RENDER_QUANTUM * 2], // 256: after stage 0 (factor 4/8)
    buffer1: [f32; RENDER_QUANTUM * 4]  // 512: after stage 1 (factor 8)
}

impl ResamplerMono {
    /// `factor` must be 2, 4, or 8.
    pub const fn new(factor: usize) -> Self {
        Self {factor, stages: [Resampler2xMono::new(); 3], buffer0: [0.0; RENDER_QUANTUM * 2], buffer1: [0.0; RENDER_QUANTUM * 4]}
    }

    pub fn reset(&mut self) {
        for stage in &mut self.stages {stage.reset();}
    }

    /// Upsample `input[from..to]` into `output[0..(to-from)*factor]`.
    pub fn upsample(&mut self, input: &[f32], output: &mut [f32], from: usize, to: usize) {
        let count = to - from;
        match self.factor {
            2 => self.stages[0].upsample(input, output, from, to),
            4 => {
                self.stages[0].upsample(input, &mut self.buffer0, from, to);
                self.stages[1].upsample(&self.buffer0, output, 0, count * 2);
            }
            _ => {
                self.stages[0].upsample(input, &mut self.buffer0, from, to);
                self.stages[1].upsample(&self.buffer0, &mut self.buffer1, 0, count * 2);
                self.stages[2].upsample(&self.buffer1, output, 0, count * 4);
            }
        }
    }

    /// Downsample `input[0..(to-from)*factor]` back into `output[from..to]`.
    pub fn downsample(&mut self, input: &[f32], output: &mut [f32], from: usize, to: usize) {
        let count = to - from;
        match self.factor {
            2 => self.stages[0].downsample(input, output, from, to),
            4 => {
                self.stages[1].downsample(input, &mut self.buffer0, 0, count * 2);
                self.stages[0].downsample(&self.buffer0, output, from, to);
            }
            _ => {
                self.stages[2].downsample(input, &mut self.buffer1, 0, count * 4);
                self.stages[1].downsample(&self.buffer1, &mut self.buffer0, 0, count * 2);
                self.stages[0].downsample(&self.buffer0, output, from, to);
            }
        }
    }
}

/// A stereo oversampler: one `ResamplerMono` per channel. Mirrors `ResamplerStereo`.
pub struct ResamplerStereo {
    left: ResamplerMono,
    right: ResamplerMono
}

impl ResamplerStereo {
    pub const fn new(factor: usize) -> Self {
        Self {left: ResamplerMono::new(factor), right: ResamplerMono::new(factor)}
    }

    pub fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
    }

    pub fn upsample(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        self.left.upsample(in_left, out_left, from, to);
        self.right.upsample(in_right, out_right, from, to);
    }

    pub fn downsample(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        self.left.downsample(in_left, out_left, from, to);
        self.right.downsample(in_right, out_right, from, to);
    }
}

#[cfg(test)]
mod tests {
    use super::{ResamplerMono, PHASE0_COEFF, PHASE1_COEFF, HALFBAND_COEFF};

    #[test]
    fn polyphase_coeffs_are_the_truncated_even_odd_taps() {
        // PHASE0 / PHASE1 are the first 12 even / 11 odd halfband taps (the TS undersized-array truncation).
        for (p0, &coeff) in PHASE0_COEFF.iter().enumerate() {
            assert_eq!(coeff, HALFBAND_COEFF[p0 * 2], "phase0 tap {p0} is even halfband tap {}", p0 * 2);
        }
        for (p1, &coeff) in PHASE1_COEFF.iter().enumerate() {
            assert_eq!(coeff, HALFBAND_COEFF[p1 * 2 + 1], "phase1 tap {p1} is odd halfband tap {}", p1 * 2 + 1);
        }
        assert_eq!(PHASE1_COEFF[7], 0.5, "the center tap survives the truncation");
    }

    // Upsample then downsample a mono block; the round trip should return the (delayed) signal, DC-preserved.
    fn round_trip(factor: usize, input: &[f32]) -> Vec<f32> {
        let mut resampler = ResamplerMono::new(factor);
        let n = input.len();
        let mut over = vec![0.0f32; n * factor];
        let mut out = vec![0.0f32; n];
        resampler.upsample(input, &mut over, 0, n);
        resampler.downsample(&over, &mut out, 0, n);
        out
    }

    #[test]
    fn dc_is_preserved_through_a_round_trip() {
        for &factor in &[2usize, 4, 8] {
            let input = vec![0.5f32; 128];
            let out = round_trip(factor, &input);
            // The filter has latency, so check the settled tail approaches the DC input.
            let tail = out[100];
            assert!((tail - 0.5).abs() < 0.05, "factor {factor}: DC preserved, tail {tail}");
        }
    }

    #[test]
    fn a_smooth_signal_survives_the_round_trip() {
        for &factor in &[2usize, 4, 8] {
            let input: Vec<f32> = (0..128).map(|i| 0.4 * (i as f32 * 0.1).sin()).collect();
            let out = round_trip(factor, &input);
            assert!(out.iter().all(|sample| sample.is_finite()));
            assert!(out.iter().any(|sample| sample.abs() > 0.1), "factor {factor}: signal present after round trip");
        }
    }

    #[test]
    fn upsample_produces_factor_times_the_samples() {
        let mut resampler = ResamplerMono::new(4);
        let input = vec![1.0f32; 32];
        let mut over = vec![0.0f32; 32 * 4];
        resampler.upsample(&input, &mut over, 0, 32);
        assert!(over.iter().all(|sample| sample.is_finite()));
        // A DC input upsampled: after the filter latency the oversampled stream approaches the input level.
        assert!((over[100] - 1.0).abs() < 0.1, "the oversampled DC level settles near the input");
    }
}
