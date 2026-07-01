//! A bit-crusher / sample-rate-reducer, a port of lib-dsp `Crusher`. A stereo lowpass (anti-alias) feeds a
//! sample-and-hold at a reduced "crushed" sample rate, whose held value is quantised to a chosen bit depth; a
//! pre-boost drives it harder and a matched post-gain balances the level, blended against the dry input by a
//! mix. The crushed rate glides on a `crush` edit; the anti-alias cutoff follows it. `f32` control math
//! (the biquad stays `f64`), mirroring the TS audibly.

use crate::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor, BUTTERWORTH_Q};
use crate::db_to_gain;
use crate::RENDER_QUANTUM;
use math::clamp;
use math::value_mapping::{Exponential, ValueMapping};

const DEFAULT_RAMP_DURATION_SECONDS: f32 = 0.020;
const MIN_CUTOFF_FREQ: f32 = 1000.0;

/// The bit-crusher DSP. Built with `new` (a zeroed instance has an all-zero filter coeff / NaN-free rate, so a
/// device constructs it in `init`). Holds its own anti-alias filters + a per-channel S&H scratch.
pub struct Crusher {
    sample_rate: f32,
    ramp_length: u32,
    filter_coeff: BiquadCoeff,
    filters: [BiquadMono; 2],
    filtered: [[f32; RENDER_QUANTUM]; 2],
    held_sample: [f32; 2],
    crushed_sample_rate: f32,
    target_crushed_sample_rate: f32,
    delta: f32,
    remaining: u32,
    phase: f32,
    bit_depth: f32,
    boost_db: f32,
    mix: f32,
    processed: bool
}

impl Crusher {
    pub fn new(sample_rate: f32) -> Self {
        let mut filter_coeff = BiquadCoeff::new();
        filter_coeff.set_lowpass_params(0.5, BUTTERWORTH_Q); // nyquist
        Self {
            sample_rate,
            ramp_length: (libm::ceilf(sample_rate * DEFAULT_RAMP_DURATION_SECONDS) as u32).max(1),
            filter_coeff,
            filters: [BiquadMono::new(), BiquadMono::new()],
            filtered: [[0.0; RENDER_QUANTUM]; 2],
            held_sample: [0.0; 2],
            crushed_sample_rate: f32::NAN,
            target_crushed_sample_rate: f32::NAN,
            delta: 0.0,
            remaining: 0,
            phase: 0.0,
            bit_depth: 8.0,
            boost_db: 0.0,
            mix: 1.0,
            processed: false
        }
    }

    /// Crush + quantise `[from, to)` of the stereo input into the output. Mirrors `Crusher.process`: the
    /// anti-alias cutoff tracks the (ramping) crushed rate, the S&H ratio is fixed for the block, the held
    /// value is bit-quantised, and dry/wet is blended then post-gained.
    pub fn process(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32], from: usize, to: usize) {
        let coeff = self.filter_coeff;
        {
            let [flt_left, flt_right] = &mut self.filtered;
            self.filters[0].process(&coeff, in_left, flt_left, from, to);
            self.filters[1].process(&coeff, in_right, flt_right, from, to);
        }
        let pre_gain = db_to_gain(self.boost_db);
        let post_gain = db_to_gain(-self.boost_db / 2.0); // half is more balanced
        let crush_ratio = self.sample_rate / self.crushed_sample_rate;
        let steps = libm::powf(2.0, self.bit_depth) - 1.0;
        let step_inv = 1.0 / steps;
        for i in from..to {
            if self.remaining > 0 {
                self.crushed_sample_rate += self.delta;
                self.remaining -= 1;
                if self.remaining == 0 {
                    self.delta = 0.0;
                    self.crushed_sample_rate = self.target_crushed_sample_rate;
                }
                self.filter_coeff.set_lowpass_params(
                    (self.crushed_sample_rate.max(MIN_CUTOFF_FREQ) / self.sample_rate) as f64, BUTTERWORTH_Q);
            }
            self.phase += 1.0;
            if self.phase >= crush_ratio {
                self.phase -= crush_ratio;
                self.held_sample[0] = clamp(round(self.filtered[0][i] * pre_gain * steps) * step_inv, -1.0, 1.0);
                self.held_sample[1] = clamp(round(self.filtered[1][i] * pre_gain * steps) * step_inv, -1.0, 1.0);
            }
            out_left[i] = (in_left[i] * (1.0 - self.mix) + self.held_sample[0] * self.mix) * post_gain;
            out_right[i] = (in_right[i] * (1.0 - self.mix) + self.held_sample[1] * self.mix) * post_gain;
        }
        self.processed = true;
    }

    /// Set the crush amount (0..1): higher lowers the crushed sample rate toward 20 Hz. Mirrors `setCrush`
    /// (`exponential(20, nyquist, value)`), gliding once a block has been processed, else jumping (and setting
    /// the anti-alias cutoff immediately). The device passes `1 - crush` (crush 1 = maximally crushed).
    pub fn set_crush(&mut self, value: f32) {
        let target = Exponential {min: 20.0, max: self.sample_rate * 0.5}.y(value);
        if self.processed && self.crushed_sample_rate.is_finite() {
            self.target_crushed_sample_rate = target;
            self.delta = (target - self.crushed_sample_rate) / self.ramp_length as f32;
            self.remaining = self.ramp_length;
        } else {
            self.crushed_sample_rate = target;
            self.filter_coeff.set_lowpass_params(
                (self.crushed_sample_rate.max(MIN_CUTOFF_FREQ) / self.sample_rate) as f64, BUTTERWORTH_Q);
        }
    }

    pub fn set_bit_depth(&mut self, bits: i32) {
        self.bit_depth = bits.clamp(1, 16) as f32;
    }

    pub fn set_boost(&mut self, db: f32) {
        self.boost_db = db;
    }

    pub fn set_mix(&mut self, mix: f32) {
        self.mix = clamp(mix, 0.0, 1.0);
    }

    pub fn reset(&mut self) {
        self.processed = false;
        self.target_crushed_sample_rate = f32::NAN;
        self.delta = 0.0;
        self.remaining = 0;
        self.phase = 0.0;
        self.held_sample = [0.0; 2];
        self.filters[0].reset();
        self.filters[1].reset();
    }
}

/// `Math.round`: `floor(x + 0.5)` (rounds half toward +infinity), NOT libm's round-half-away-from-zero.
#[inline]
fn round(x: f32) -> f32 {
    libm::floorf(x + 0.5)
}

#[cfg(test)]
mod tests {
    use super::Crusher;

    const SR: f32 = 48_000.0;

    // The scratch is one render quantum, so a process call spans <= RENDER_QUANTUM samples (as the engine drives it).
    const N: usize = 128;

    fn sine(scale: f32, step: f32) -> Vec<f32> {
        (0..N).map(|i| scale * libm::sinf(i as f32 * step)).collect()
    }

    #[test]
    fn output_stays_finite_and_bounded() {
        let mut crusher = Crusher::new(SR);
        crusher.set_crush(0.5);
        crusher.set_bit_depth(8);
        crusher.set_boost(6.0);
        crusher.set_mix(1.0);
        let input = sine(0.7, 0.05);
        let (mut left, mut right) = (vec![0.0f32; N], vec![0.0f32; N]);
        crusher.process(&input, &input, &mut left, &mut right, 0, N);
        assert!(left.iter().all(|sample| sample.is_finite()));
        assert!(left.iter().all(|sample| sample.abs() <= 1.2), "clamp keeps it bounded");
    }

    #[test]
    fn dry_mix_passes_the_input_through_when_unboosted() {
        // mix 0 -> pure dry, post-gain unity (no boost): output equals input exactly.
        let mut crusher = Crusher::new(SR);
        crusher.set_crush(0.5);
        crusher.set_bit_depth(4);
        crusher.set_boost(0.0);
        crusher.set_mix(0.0);
        let input = [0.7f32, -0.3, 0.9, -0.5];
        let (mut left, mut right) = (vec![0.0f32; 4], vec![0.0f32; 4]);
        crusher.process(&input, &input, &mut left, &mut right, 0, 4);
        for (got, want) in left.iter().zip(input) {
            assert!((got - want).abs() < 1e-6, "dry pass-through: {got} vs {want}");
        }
    }

    #[test]
    fn low_bit_depth_quantises_to_discrete_steps() {
        // 1-bit, near-nyquist rate (crushRatio ~2, so the S&H updates within a block), no boost, full wet:
        // each held sample is round(x) clamped -> one of {-1, 0, 1}.
        let mut crusher = Crusher::new(SR);
        crusher.set_crush(1.0); // nyquist -> crushRatio 2
        crusher.set_bit_depth(1);
        crusher.set_boost(0.0);
        crusher.set_mix(1.0);
        let input = sine(0.9, 0.3);
        let (mut left, mut right) = (vec![0.0f32; N], vec![0.0f32; N]);
        crusher.process(&input, &input, &mut left, &mut right, 0, N);
        let mut saw_nonzero = false;
        for sample in &left {
            assert!(sample.is_finite());
            let nearest = [-1.0f32, 0.0, 1.0].iter().map(|step| (sample - step).abs()).fold(f32::MAX, f32::min);
            assert!(nearest < 1e-4, "1-bit output snaps to a discrete step, got {sample}");
            saw_nonzero |= sample.abs() > 0.5;
        }
        assert!(saw_nonzero, "the S&H actually updated within the block");
    }

    #[test]
    fn boost_scales_the_output_level() {
        // A positive boost pre-amplifies into the quantiser then post-attenuates by half the boost, so the net
        // level rises. Compare the peak of a boosted vs unboosted run.
        let signal = sine(0.2, 0.03);
        let run = |boost: f32| {
            let mut crusher = Crusher::new(SR);
            crusher.set_crush(1.0);
            crusher.set_bit_depth(16);
            crusher.set_boost(boost);
            crusher.set_mix(1.0);
            let (mut left, mut right) = (vec![0.0f32; N], vec![0.0f32; N]);
            crusher.process(&signal, &signal, &mut left, &mut right, 0, N);
            left.iter().fold(0.0f32, |max, sample| max.max(sample.abs()))
        };
        assert!(run(12.0) > run(0.0) * 1.5, "a 12 dB boost noticeably raises the level");
    }
}
