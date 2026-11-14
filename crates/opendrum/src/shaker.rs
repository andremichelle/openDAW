//! openDrum Shaker: noise through a high-pass at Color and a fixed low-pass above, swelling in over Attack and
//! fading over Decay (Curve shapes the fade). Covers maracas, shakers and cabasas. Every hit has its own noise.

use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::svf::{Svf, SvfCoefficients};
use crate::kick::Play;

pub const VOICES: usize = 8;

// the low-pass above (the 808 maracas roll off from about 18 kHz)
const TOP: f32 = 18000.0;
// the level follows the width of the passed band against this Color, so the loudness stays put
const COLOR_REFERENCE: f32 = 7500.0;
const OUTPUT_GAIN: f32 = 1.2;
const ENVELOPE_FLOOR: f32 = 0.00001;

/// Times in seconds, Color in Hz, Volume in dB, Curve -1 to 1, Velocity 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct ShakerParams {
    pub color: f32,
    pub attack: f32,
    pub decay: f32,
    pub curve: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for ShakerParams {
    fn default() -> Self {
        Self {color: 7500.0, attack: 0.018, decay: 0.014, curve: 0.0, volume: 0.0, velocity: 0.5, play: Play::Mono}
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    id: u32,
    age: u32,
    level: f32,
    amp: HitEnvelope,
    noise: WhiteNoise,
    filters: [Svf; 2]
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, params: &ShakerParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.id = id;
        self.age = age;
        self.level = strength;
        self.noise.reset(age.wrapping_mul(0x85EB_CA6B) ^ 0x5AA1);
        if restart {self.filters.iter_mut().for_each(|filter| filter.reset());}
        self.amp.set(params.attack.max(0.0), 0.0, params.decay.max(0.002), sample_rate);
        self.amp.set_curve(params.curve);
        self.amp.set_floor(ENVELOPE_FLOOR);
        if params.play == Play::Gate {self.amp.trigger_held(1.0);} else {self.amp.trigger(1.0);}
    }

    #[inline]
    fn render(&mut self, high: &SvfCoefficients, low: &SvfCoefficients) -> f32 {
        let filtered = self.filters[0].process(self.noise.next(), high).high;
        let filtered = self.filters[1].process(filtered, low).low;
        let value = filtered * self.amp.next();
        if self.amp.is_idle() {self.active = false;}
        value * self.level
    }
}

pub struct Shaker {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32
}

impl Shaker {
    pub fn new(sample_rate: f32) -> Self {Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0}}

    /// `velocity` 0 to 1. The key does not move the sound.
    pub fn note_on(&mut self, id: u32, velocity: f32, params: &ShakerParams) {
        self.hits = self.hits.wrapping_add(1);
        let strength = 1.0 - params.velocity * (1.0 - velocity.clamp(0.0, 1.0));
        let index = match params.play {
            Play::Poly => self.voices.iter().position(|voice| !voice.active).unwrap_or_else(|| {
                (0..VOICES).min_by_key(|index| self.voices[*index].age).unwrap_or(0)
            }),
            _ => 0
        };
        let (hits, sample_rate) = (self.hits, self.sample_rate);
        self.voices[index].start(id, hits, strength, params, sample_rate);
    }

    pub fn note_off(&mut self, id: u32, params: &ShakerParams) {
        if params.play != Play::Gate {return;}
        self.voices.iter_mut().filter(|voice| voice.active && voice.id == id).for_each(|voice| voice.amp.release());
    }

    pub fn process(&mut self, params: &ShakerParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let nyquist_guard = sample_rate * 0.45;
        let top = TOP.min(nyquist_guard);
        let color = params.color.clamp(200.0, top * 0.9);
        let high = SvfCoefficients::new(color, 0.707, sample_rate);
        let low = SvfCoefficients::new(top, 0.707, sample_rate);
        let width = libm::sqrtf((top - COLOR_REFERENCE) / (top - color));
        let level = libm::powf(10.0, params.volume / 20.0) * width * OUTPUT_GAIN;
        for value in output.iter_mut() {
            *value = self.voices.iter_mut().filter(|voice| voice.active)
                .map(|voice| voice.render(&high, &low)).sum::<f32>() * level;
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(shaker: &mut Shaker, params: &ShakerParams, seconds: f32) -> Vec<f32> {
        shaker.note_on(1, 1.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        shaker.process(params, &mut output);
        output
    }

    fn rms(samples: &[f32]) -> f32 {
        libm::sqrtf(samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32)
    }

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = ShakerParams {color: 200.0, attack: 0.0, decay: 0.002, curve: -1.0, volume: -36.0, velocity: 0.0,
            play: Play::Mono};
        let high = ShakerParams {color: 16000.0, attack: 0.2, decay: 2.0, curve: 1.0, volume: 0.0, velocity: 1.0,
            play: Play::Poly};
        for params in [low, high, ShakerParams::default()] {
            let samples = render(&mut Shaker::new(RATE), &params, 1.0);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 4.0));
        }
    }

    #[test]
    fn it_swells_in_and_ends_silent() {
        let params = ShakerParams::default();
        let mut shaker = Shaker::new(RATE);
        let samples = render(&mut shaker, &params, 0.2);
        let window = |ms: f32| rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 3.0) * RATE / 1000.0) as usize]);
        assert!(window(15.0) > window(1.0) * 4.0, "louder at the end of the attack than at its start");
        assert!(shaker.is_silent());
    }

    #[test]
    fn every_hit_has_its_own_noise() {
        let params = ShakerParams::default();
        let mut shaker = Shaker::new(RATE);
        let first = render(&mut shaker, &params, 0.2);
        let second = render(&mut shaker, &params, 0.2);
        assert_ne!(first, second);
        assert_eq!(first, render(&mut Shaker::new(RATE), &params, 0.2), "a fresh engine repeats exactly");
    }
}
