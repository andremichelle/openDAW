//! Stages every openDrum engine shares: the click (an impulse plus a noise burst, band passed at Tone) and the
//! asymmetric, oversampled drive with its DC blocker.

use dsp::noise::WhiteNoise;
use dsp::resampler::ResamplerMono;
use dsp::svf::{Svf, SvfCoefficients};
use dsp::RENDER_QUANTUM;

pub const CLICK_LENGTH: f32 = 0.03;
const CLICK_NOISE: f32 = 0.006;
const CLICK_GAIN: f32 = 3.0;
const CLICK_Q: f32 = 1.5;
/// The full asymmetry of the drive, an engine passes this or less.
pub const DRIVE_BIAS: f32 = 0.3;

/// The click's per block values for one Tone.
#[derive(Clone, Copy, Default)]
pub struct ClickShape {
    scale: f32,
    filter: SvfCoefficients
}

impl ClickShape {
    pub fn new(tone: f32, sample_rate: f32) -> Self {
        Self {scale: sample_rate / (core::f32::consts::PI * tone.max(20.0)), filter: SvfCoefficients::new(tone, CLICK_Q, sample_rate)}
    }
}

#[derive(Clone, Copy, Default)]
pub struct Click {
    filter: Svf,
    noise: WhiteNoise
}

impl Click {
    pub fn reset(&mut self, seed: u32, restart: bool) {
        self.noise.reset(seed);
        if restart {self.filter.reset();}
    }

    /// `elapsed` counts the samples since the hit including this one (1 on the first), `noise` mixes impulse (0)
    /// and noise burst (1).
    #[inline]
    pub fn render(&mut self, elapsed: u32, seconds: f32, shape: &ClickShape, noise: f32) -> f32 {
        if seconds >= CLICK_LENGTH {return 0.0;}
        let pulse = if elapsed == 1 {shape.scale * 2.0 * (1.0 - noise)} else {0.0};
        let burst = self.noise.next() * noise * libm::expf(-seconds / CLICK_NOISE);
        self.filter.process(pulse + burst, &shape.filter).band * CLICK_GAIN
    }
}

/// Asymmetric soft saturation like a diode (it adds even harmonics), 2x oversampled, DC blocked. 0 dB is bypassed.
pub struct Drive {
    dc_block: f32,
    oversampler: ResamplerMono,
    oversampled: [f32; RENDER_QUANTUM * 2],
    dc_input: f32,
    dc_output: f32
}

impl Drive {
    /// `dc_block` is the high pass after the saturation in Hz, low for a kick, higher for a snare whose drive
    /// would otherwise leave a low thump.
    pub fn new(dc_block: f32) -> Self {
        Self {dc_block, oversampler: ResamplerMono::new(2), oversampled: [0.0; RENDER_QUANTUM * 2], dc_input: 0.0, dc_output: 0.0}
    }

    /// `input` holds at least `output.len()` samples, at most one render quantum. `bias` sets the asymmetry.
    pub fn process(&mut self, drive: f32, bias: f32, sample_rate: f32, input: &[f32], output: &mut [f32]) {
        let frames = output.len();
        if drive <= 0.0 {
            output.copy_from_slice(&input[..frames]);
            return;
        }
        let gain = libm::powf(10.0, drive / 20.0);
        let dc_coefficient = 1.0 - 2.0 * core::f32::consts::PI * self.dc_block / sample_rate;
        self.oversampler.upsample(input, &mut self.oversampled, 0, frames);
        let offset = libm::tanhf(bias);
        self.oversampled[..frames * 2].iter_mut().for_each(|value| *value = libm::tanhf(*value * gain + bias) - offset);
        self.oversampler.downsample(&self.oversampled, output, 0, frames);
        for value in output.iter_mut() {
            let input = *value;
            self.dc_output = input - self.dc_input + dc_coefficient * self.dc_output;
            self.dc_input = input;
            *value = self.dc_output;
        }
    }
}

/// A symmetric clipper, 2x oversampled, that blends from the soft curve of `Drive` to a hard clip: bright while it
/// clips and clean as soon as the level falls under the ceiling.
pub struct Clipper {
    oversampler: ResamplerMono,
    oversampled: [f32; RENDER_QUANTUM * 2]
}

impl Default for Clipper {
    fn default() -> Self {Self::new()}
}

impl Clipper {
    pub fn new() -> Self {Self {oversampler: ResamplerMono::new(2), oversampled: [0.0; RENDER_QUANTUM * 2]}}

    /// `input` holds at least `output.len()` samples, at most one render quantum. `drive` in dB, `hard` 0 to 1.
    pub fn process(&mut self, drive: f32, hard: f32, input: &[f32], output: &mut [f32]) {
        let frames = output.len();
        let gain = libm::powf(10.0, drive / 20.0);
        self.oversampler.upsample(input, &mut self.oversampled, 0, frames);
        for value in self.oversampled[..frames * 2].iter_mut() {
            let driven = *value * gain;
            let soft = libm::tanhf(driven);
            *value = soft + (driven.clamp(-1.0, 1.0) - soft) * hard;
        }
        self.oversampler.downsample(&self.oversampled, output, 0, frames);
    }
}
