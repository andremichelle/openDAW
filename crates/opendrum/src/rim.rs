//! openDrum Rim: up to three pinged tones (Tune, a second at Ratio with Balance, a third at Ratio Hi with High) that
//! swell in over Swell of their own cycles and ring for Ring (the second for Ring Hi, the third half of that), cut by a short
//! envelope (Decay, Punch for the hard cut of the 808), driven together so they intermodulate (Hard turns the drive into a hard clip, the 909), with a click on the
//! attack at the third tone's pitch and a high-pass (Cut). With Restart off the tones start every hit somewhere else
//! in their cycles, audible once they are driven. Covers rimshots, claves and side sticks.

use dsp::drum_oscillator::DrumOscillator;
use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::svf::{Svf, SvfCoefficients};
use dsp::RENDER_QUANTUM;
use crate::common::{Click, ClickShape, Clipper, Cut, Drive, CLICK_LENGTH, DRIVE_BIAS};
use crate::common::Play;

pub const VOICES: usize = 8;

// the third tone rings this share of Ring Hi
const THIRD_RING: f32 = 0.5;
// in Gate a hit ends this fast when its note ends
const RELEASE: f32 = 0.002;
const CLICK_NOISE_MIX: f32 = 0.5;
// one seed for every hit: a rim or claves hit repeats exactly
const CLICK_SEED: u32 = 0x9E37_79B9 ^ 0x21A1;
const ENVELOPE_FLOOR: f32 = 0.00001;
const DRIVE_DC_BLOCK: f32 = 30.0;
const DRIVE_BIAS_FULL: f32 = 12.0;

/// Times in seconds, Tune and Cut in Hz, Swell in cycles, Drive and Volume in dB, Punch -1 to 1, Ratio as a frequency ratio, the rest
/// 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct RimParams {
    pub tune: f32,
    pub ratio: f32,
    pub balance: f32,
    pub high: f32,
    pub high_ratio: f32,
    pub ring: f32,
    pub ring_high: f32,
    pub decay: f32,
    pub punch: f32,
    pub drive: f32,
    pub hard: f32,
    pub click: f32,
    pub swell: f32,
    pub cut: f32,
    pub restart: bool,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for RimParams {
    fn default() -> Self {
        Self {
            tune: 450.0, ratio: 3.6, balance: 0.5, high: 0.0, high_ratio: 8.0, ring: 0.15, ring_high: 0.05, decay: 0.03, punch: 0.5,
            drive: 6.0, hard: 0.0, click: 0.2, swell: 3.0, cut: 200.0, restart: true, volume: 0.0, velocity: 0.5,
            play: Play::Mono
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    id: u32,
    age: u32,
    level: f32,
    transpose: f32,
    elapsed: u32,
    tones: [DrumOscillator; 3],
    rings: [f32; 3],
    ring_factors: [f32; 3],
    amp: HitEnvelope,
    click: Click,
    cut: Cut
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &RimParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.id = id;
        self.age = age;
        self.level = strength;
        self.transpose = transpose;
        self.elapsed = 0;
        self.cut.reset();
        if params.restart {
            self.tones.iter_mut().for_each(|tone| tone.reset(0.0));
        } else {
            let mut random = WhiteNoise::default();
            random.reset(age.wrapping_mul(0x85EB_CA6B) ^ 0x21A2);
            self.tones.iter_mut().for_each(|tone| tone.reset(f64::from(random.next() + 1.0) * 0.5));
        }
        self.rings = [1.0; 3];
        self.ring_factors = [params.ring, params.ring_high, params.ring_high * THIRD_RING]
            .map(|ring| libm::expf(libm::logf(0.001) / (ring.max(0.001) * sample_rate)));
        self.click.reset(CLICK_SEED, restart);
        self.amp.set(0.0, 0.0, params.decay, sample_rate);
        self.amp.set_curve(params.punch);
        self.amp.set_floor(ENVELOPE_FLOOR);
        self.amp.trigger(1.0);
    }

    #[inline]
    fn render(&mut self, params: &RimParams, click: &ClickShape, sample_rate: f32) -> f32 {
        let seconds = self.elapsed as f32 / sample_rate;
        self.elapsed = self.elapsed.saturating_add(1);
        let nyquist_guard = sample_rate * 0.45;
        let first = params.tune * libm::exp2f(self.transpose / 12.0);
        let second = (first * params.ratio).min(nyquist_guard);
        let third = (first * params.high_ratio).min(nyquist_guard);
        let cycles = params.swell.max(0.01);
        let swell = |frequency: f32| (seconds * frequency / cycles).min(1.0);
        let low = self.tones[0].sine(first.min(nyquist_guard), sample_rate) * swell(first) * self.rings[0];
        let middle = self.tones[1].sine(second, sample_rate) * params.balance * swell(second) * self.rings[1];
        let top = self.tones[2].sine(third, sample_rate) * params.high * swell(third) * self.rings[2];
        let mut value = (low + middle + top) * self.amp.next();
        for (ring, factor) in self.rings.iter_mut().zip(self.ring_factors.iter()) {*ring *= factor;}
        if seconds < CLICK_LENGTH {
            value += self.click.render(self.elapsed, seconds, click, CLICK_NOISE_MIX) * params.click;
        }
        let cut = self.cut.next();
        if (self.amp.is_idle() && seconds >= CLICK_LENGTH) || self.cut.is_done() {self.active = false;}
        value * self.level * cut
    }
}

pub struct Rim {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32,
    drive: Drive,
    clipper: Clipper,
    high_pass: Svf,
    dry: [f32; RENDER_QUANTUM]
}

impl Rim {
    pub fn new(sample_rate: f32) -> Self {
        Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0, drive: Drive::new(DRIVE_DC_BLOCK),
            clipper: Clipper::new(),            high_pass: Svf::default(), dry: [0.0; RENDER_QUANTUM]}
    }

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &RimParams) {
        self.hits = self.hits.wrapping_add(1);
        let strength = 1.0 - params.velocity * (1.0 - velocity.clamp(0.0, 1.0));
        let index = match params.play {
            Play::Poly => self.voices.iter().position(|voice| !voice.active).unwrap_or_else(|| {
                (0..VOICES).min_by_key(|index| self.voices[*index].age).unwrap_or(0)
            }),
            _ => 0
        };
        let (hits, sample_rate) = (self.hits, self.sample_rate);
        self.voices[index].start(id, hits, strength, transpose, params, sample_rate);
    }

    pub fn process(&mut self, params: &RimParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let click = ClickShape::new((params.tune * params.high_ratio).clamp(200.0, 16000.0), sample_rate);
        let cut = SvfCoefficients::new(params.cut.clamp(20.0, sample_rate * 0.45), 0.707, sample_rate);
        let volume = libm::powf(10.0, params.volume / 20.0);
        let bias = DRIVE_BIAS * (params.drive / DRIVE_BIAS_FULL).clamp(0.0, 1.0);
        for chunk in output.chunks_mut(RENDER_QUANTUM) {
            let frames = chunk.len();
            for frame in 0..frames {
                self.dry[frame] = self.voices.iter_mut().filter(|voice| voice.active)
                    .map(|voice| voice.render(params, &click, sample_rate)).sum();
            }
            if params.hard > 0.0 {
                self.clipper.process(params.drive, params.hard.min(1.0), &self.dry, chunk);
            } else {
                self.drive.process(params.drive, bias, sample_rate, &self.dry, chunk);
            }
            for value in chunk.iter_mut() {*value = self.high_pass.process(*value, &cut).high * volume;}
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}

    voice_queries!(RimParams, RELEASE);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &RimParams, seconds: f32) -> Vec<f32> {
        let mut rim = Rim::new(RATE);
        rim.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        rim.process(params, &mut output);
        output
    }

    fn rms(samples: &[f32]) -> f32 {libm::sqrtf(samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32)}

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = RimParams {tune: 100.0, ratio: 1.0, balance: 0.0, high: 0.0, high_ratio: 1.0, ring: 0.005, ring_high: 0.005,
            decay: 0.002, punch: -1.0, drive: 0.0, hard: 0.0, click: 0.0, swell: 0.0, cut: 20.0,
            restart: true, volume: -36.0, velocity: 0.0, play: Play::Mono};
        let high = RimParams {tune: 4000.0, ratio: 5.0, balance: 1.0, high: 1.0, high_ratio: 12.0, ring: 1.0, ring_high: 1.0, decay: 0.5,
            punch: 1.0, drive: 36.0, hard: 1.0, click: 1.0, swell: 8.0, cut: 4000.0,
            restart: false, volume: 0.0, velocity: 1.0, play: Play::Poly};
        for params in [low, high, RimParams::default()] {
            let samples = render(&params, 1.0);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 8.0));
        }
    }

    #[test]
    fn identical_renders() {
        let params = RimParams {click: 0.8, ..RimParams::default()};
        assert_eq!(render(&params, 0.2), render(&params, 0.2));
    }

    #[test]
    fn a_positive_punch_cuts_the_ring_at_decay() {
        let params = RimParams {decay: 0.01, punch: 1.0, ring: 0.5, click: 0.0, drive: 0.0, ..RimParams::default()};
        let samples = render(&params, 0.1);
        let window = |ms: f32| rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 2.0) * RATE / 1000.0) as usize]);
        assert!(window(14.0) < window(6.0) * 0.01, "loud inside the decay, cut after it");
    }

    #[test]
    fn ends_silent() {
        let params = RimParams::default();
        let mut rim = Rim::new(RATE);
        rim.note_on(1, 1.0, 0.0, &params);
        let mut output = vec![0.0; (0.2 * RATE) as usize];
        rim.process(&params, &mut output);
        assert!(rim.is_silent());
    }
}
