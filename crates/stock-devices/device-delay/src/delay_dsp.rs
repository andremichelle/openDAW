//! The Delay's core DSP, a faithful port of TS `DelayDeviceDsp`: a circular stereo delay with fractional read
//! interpolation, a per-channel biquad filter (one shared coeff), a smoothed triangle LFO modulating the read
//! position, delay-time interpolation over 0.25 s, a peak limiter on the delay return, and cross-feedback.
//! Buffer-BORROWING and heap-free: the device owns the pow2-sized delay buffers in its rate-sized state and
//! passes them in; this holds only the DSP state. Per-sample math is f64 (like the TS `number`), buffers f32.

use dsp::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor};
use dsp::smooth::Smooth;

const LIMITER_ATTACK_MS: f64 = 50.0;
const LIMITER_RELEASE_MS: f64 = 250.0;
const SQRT1_2: f64 = core::f64::consts::FRAC_1_SQRT_2; // the biquad's default resonance (TS `Math.SQRT1_2`)
const MAX_CHUNK: usize = 128; // the render quantum; the pre-delay scratch is one quantum wide

pub struct DelayDsp {
    biquad_l: BiquadMono,
    biquad_r: BiquadMono,
    coeff: BiquadCoeff,
    pre_delay_l: crate::delay::PreDelay,
    pre_delay_r: crate::delay::PreDelay,
    lfo_depth_smoother: Smooth,
    smooth_coeff: f64,
    envelope_attack: f64,
    envelope_release: f64,
    filter_min: f64, // 20 / sample_rate (normalised), the FilterMapping range
    filter_max: f64, // 20000 / sample_rate
    delay_size: usize,
    current_offset: f64,
    delay_line_position: usize,
    target_offset: f64,
    delta_offset: f64,
    alpha_position: i32,
    interpolation_length: i32,
    envelope: f64,
    lfo_phase: f64,
    processed: bool,
    pub feedback: f64,
    pub cross: f64,
    pub lfo_phase_incr: f64,
    pub lfo_depth: f64,
    pub wet: f64,
    pub dry: f64
}

impl DelayDsp {
    pub fn new(sample_rate: f32, delay_size: usize) -> Self {
        let sample_rate = sample_rate as f64;
        let interpolation_length = (0.250 * sample_rate) as i32;
        Self {
            biquad_l: BiquadMono::new(),
            biquad_r: BiquadMono::new(),
            coeff: BiquadCoeff::new(),
            pre_delay_l: crate::delay::PreDelay::new(interpolation_length),
            pre_delay_r: crate::delay::PreDelay::new(interpolation_length),
            lfo_depth_smoother: Smooth::default(),
            smooth_coeff: Smooth::coefficient(0.003, sample_rate),
            envelope_attack: libm::exp(-1.0 / (sample_rate * LIMITER_ATTACK_MS)),
            envelope_release: libm::exp(-1.0 / (sample_rate * LIMITER_RELEASE_MS)),
            filter_min: 20.0 / sample_rate,
            filter_max: 20000.0 / sample_rate,
            delay_size,
            current_offset: 0.0,
            delay_line_position: 0,
            target_offset: 0.0,
            delta_offset: 0.0,
            alpha_position: 0,
            interpolation_length,
            envelope: 0.0,
            lfo_phase: 0.0,
            processed: false,
            feedback: 0.5,
            cross: 0.0,
            lfo_phase_incr: 0.0,
            lfo_depth: 0.0,
            wet: 0.75,
            dry: 0.75
        }
    }

    /// Reset the heads + (provided) buffers, mirroring `reset` (clears state only once it has processed).
    pub fn reset(&mut self, delay: [&mut [f32]; 2], pre: [&mut [f32]; 2]) {
        let [delay_l, delay_r] = delay;
        let [pre_l, pre_r] = pre;
        self.delay_line_position = 0;
        self.pre_delay_l.clear(pre_l);
        self.pre_delay_r.clear(pre_r);
        if self.processed {
            self.biquad_l.reset();
            self.biquad_r.reset();
            delay_l.fill(0.0);
            delay_r.fill(0.0);
            self.processed = false;
            self.envelope = 0.0;
            self.lfo_phase = 0.0;
        }
        self.init_delay_time();
    }

    pub fn set_pre_delay_left_offset(&mut self, value: f64) {
        self.pre_delay_l.set_offset(crate::delay::clamp_offset(value, self.delay_size));
    }

    pub fn set_pre_delay_right_offset(&mut self, value: f64) {
        self.pre_delay_r.set_offset(crate::delay::clamp_offset(value, self.delay_size));
    }

    /// Set the main delay offset in frames (a change glides over the interpolation length once running).
    pub fn set_offset(&mut self, value: f64) {
        let value = crate::delay::clamp_offset(value, self.delay_size);
        if self.target_offset == value {
            return;
        }
        self.target_offset = value;
        if self.processed {
            self.update_delay_time();
        } else {
            self.init_delay_time();
        }
    }

    /// The filter: bipolar, 0 = bypass, > 0 = high-pass, < 0 = low-pass; the cutoff is exponential over
    /// `[20, 20000]` Hz (normalised). Mirrors the `filter` setter.
    pub fn set_filter(&mut self, value: f32) {
        let value = value as f64;
        if value == 0.0 {
            self.coeff.identity();
        } else if value > 0.0 {
            self.coeff.set_highpass_params(self.filter_freq(value), SQRT1_2);
        } else {
            self.coeff.set_lowpass_params(self.filter_freq(1.0 + value), SQRT1_2);
        }
    }

    fn filter_freq(&self, unit: f64) -> f64 {
        self.filter_min * libm::pow(self.filter_max / self.filter_min, unit)
    }

    fn init_delay_time(&mut self) {
        self.current_offset = self.target_offset;
        self.alpha_position = 0;
    }

    fn update_delay_time(&mut self) {
        if self.target_offset != self.current_offset {
            self.alpha_position = self.interpolation_length;
            self.delta_offset = (self.target_offset - self.current_offset) / self.alpha_position as f64;
        }
    }

    /// Process `[0, len)` (rebased) of one chunk: `delay` are the two delay-line buffers, `pre` the two
    /// pre-delay-line buffers (both pow2-sized from the rate-sized state). A faithful port of `process`.
    #[allow(clippy::too_many_arguments)]
    pub fn process(&mut self, input: [&[f32]; 2], output: [&mut [f32]; 2], delay: [&mut [f32]; 2], pre: [&mut [f32]; 2]) {
        let [input_l, input_r] = input;
        let [output_l, output_r] = output;
        let [delay_l, delay_r] = delay;
        let [pre_l, pre_r] = pre;
        let len = input_l.len();
        let mut pre_scratch_l = [0.0f32; MAX_CHUNK];
        let mut pre_scratch_r = [0.0f32; MAX_CHUNK];
        self.pre_delay_l.process(&mut pre_scratch_l, input_l, pre_l, 0, len);
        self.pre_delay_r.process(&mut pre_scratch_r, input_r, pre_r, 0, len);
        let cross = self.cross;
        let pass = 1.0 - cross;
        let mask = self.delay_size - 1;
        let feedback = self.feedback;
        let wet_level = self.wet;
        let dry_level = self.dry;
        for index in 0..len {
            if self.alpha_position > 0 {
                self.current_offset += self.delta_offset;
                self.alpha_position -= 1;
            } else {
                self.current_offset = self.target_offset;
            }
            let lfo_depth = self.lfo_depth_smoother.process(self.smooth_coeff, self.lfo_depth);
            let lfo_value = 2.0 * (self.lfo_phase - 0.5).abs() * lfo_depth;
            self.lfo_phase += self.lfo_phase_incr;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }
            let mut read_float = self.delay_line_position as f64 - (self.current_offset + lfo_depth - lfo_value);
            if read_float < 0.0 {
                read_float += self.delay_size as f64;
            }
            let read_int0 = read_float as usize;
            let read_int1 = (read_int0 + 1) & mask;
            let alpha = read_float - read_int0 as f64;
            let l0 = delay_l[read_int0 & mask] as f64;
            let r0 = delay_r[read_int0 & mask] as f64;
            let mut read_delay_l = l0 + alpha * (delay_l[read_int1] as f64 - l0);
            let mut read_delay_r = r0 + alpha * (delay_r[read_int1] as f64 - r0);
            let abs = read_delay_l.abs().max(read_delay_r.abs());
            self.envelope = if abs > self.envelope {
                self.envelope_attack * (self.envelope - abs) + abs
            } else {
                self.envelope_release * (self.envelope - abs) + abs
            };
            if self.envelope > 1.0 {
                read_delay_l /= self.envelope;
                read_delay_r /= self.envelope;
            }
            let processed_l = self.biquad_l.process_frame(&self.coeff, (read_delay_l * pass + read_delay_r * cross) * 0.96);
            let processed_r = self.biquad_r.process_frame(&self.coeff, (read_delay_r * pass + read_delay_l * cross) * 0.96);
            delay_l[self.delay_line_position] = (pre_scratch_l[index] as f64 + processed_l * feedback + 1.0e-18 - 1.0e-18) as f32;
            delay_r[self.delay_line_position] = (pre_scratch_r[index] as f64 + processed_r * feedback + 1.0e-18 - 1.0e-18) as f32;
            output_l[index] = (input_l[index] as f64 * dry_level + processed_l * wet_level) as f32;
            output_r[index] = (input_r[index] as f64 * dry_level + processed_r * wet_level) as f32;
            self.delay_line_position = (self.delay_line_position + 1) & mask;
            delay_l[self.delay_line_position] = 0.0;
            delay_r[self.delay_line_position] = 0.0;
        }
        self.processed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::DelayDsp;

    const SR: f32 = 48_000.0;

    #[test]
    fn an_impulse_echoes_at_the_offset_with_feedback() {
        let size = 4096usize;
        let mut dsp = DelayDsp::new(SR, size);
        dsp.dry = 0.0; // hear only the wet path, so echoes are isolated
        dsp.wet = 1.0;
        dsp.feedback = 0.5;
        dsp.set_offset(1000.0); // 1000-frame delay
        let (mut delay_l, mut delay_r) = (vec![0.0f32; size], vec![0.0f32; size]);
        let (mut pre_l, mut pre_r) = (vec![0.0f32; size], vec![0.0f32; size]);
        let len = 2400;
        let mut input_l = vec![0.0f32; len];
        input_l[0] = 1.0; // an impulse on the left
        let input_r = vec![0.0f32; len];
        let (mut out_l, mut out_r) = (vec![0.0f32; len], vec![0.0f32; len]);
        // The engine drives the DSP one render quantum (128 frames) at a time; feed the block in chunks.
        let mut from = 0;
        while from < len {
            let to = (from + super::MAX_CHUNK).min(len);
            let in_l = &input_l[from..to];
            let in_r = &input_r[from..to];
            let (out_chunk_l, out_chunk_r) = (&mut out_l[from..to], &mut out_r[from..to]);
            dsp.process([in_l, in_r], [out_chunk_l, out_chunk_r], [&mut delay_l, &mut delay_r], [&mut pre_l, &mut pre_r]);
            from = to;
        }
        // first echo ~1000 frames out, a second ~2000 (feedback), each quieter.
        let first = out_l[990..1010].iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        let second = out_l[1990..2010].iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        assert!(first > 0.5, "first echo near the delay offset, got {first}");
        assert!(second > 0.1 && second < first, "second (fed-back) echo is quieter, got {second} vs {first}");
    }
}
