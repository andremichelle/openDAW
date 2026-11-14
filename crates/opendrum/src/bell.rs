//! openDrum Bell: two pulse oscillators (Tune and Tune x Ratio, the lower one at Balance) through a band-pass at
//! Color. The level falls in two stages: Strike is the share that is gone within 50 ms, the rest rings for Decay.
//! Covers cowbells, agogos and tuned bells. Every hit starts the oscillators at the same point, bells repeat exactly.

use dsp::hit_envelope::HitEnvelope;
use dsp::svf::{Svf, SvfCoefficients};
use crate::common::{pulse, Cut};
use crate::common::Play;

pub const VOICES: usize = 8;

// the 808 cowbell's pulses are high for 44 % of their cycle (fitted to its even harmonics)
const WIDTH: f32 = 0.44;
const BAND_Q: f32 = 4.0;
// a band that lets more of the tones through than the 808 cowbell does is turned down to its level
const HARMONICS: usize = 48;
const STRIKE_DECAY: f32 = 0.05;
const OUTPUT_GAIN: f32 = 0.36;
const ENVELOPE_FLOOR: f32 = 0.00001;
// in Gate a hit ends this fast when its note ends
const RELEASE: f32 = 0.005;

/// Tune and Color in Hz, Ratio as a frequency ratio, Decay in seconds, Volume in dB, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct BellParams {
    pub tune: f32,
    pub ratio: f32,
    pub balance: f32,
    pub color: f32,
    pub strike: f32,
    pub decay: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for BellParams {
    fn default() -> Self {
        Self {
            tune: 558.0, ratio: 1.477, balance: 0.7, color: 1050.0, strike: 0.8, decay: 0.7,
            volume: 0.0, velocity: 0.5, play: Play::Mono
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    id: u32,
    age: u32,
    level: f32,
    elapsed: u32,
    transpose: f32,
    phases: [f32; 2],
    strike: HitEnvelope,
    ring: HitEnvelope,
    filter: Svf,
    cut: Cut
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &BellParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.elapsed = 0;
        self.cut.reset();
        self.id = id;
        self.age = age;
        self.level = strength;
        self.transpose = transpose;
        if restart {
            self.filter.reset();
            self.phases = [0.0; 2];
        }
        let decay = params.decay.max(0.01);
        self.strike.set(0.0, 0.0, STRIKE_DECAY.min(decay), sample_rate);
        self.ring.set(0.0, 0.0, decay, sample_rate);
        for envelope in [&mut self.strike, &mut self.ring] {
            envelope.set_floor(ENVELOPE_FLOOR);
            envelope.trigger(1.0);
        }
    }

    #[inline]
    fn render(&mut self, params: &BellParams, band: &SvfCoefficients, sample_rate: f32) -> f32 {
        self.elapsed = self.elapsed.saturating_add(1);
        let base = params.tune * libm::exp2f(self.transpose / 12.0) / sample_rate;
        let steps = [base, base * params.ratio];
        let mut waves = [0.0; 2];
        for ((phase, step), wave) in self.phases.iter_mut().zip(steps.iter()).zip(waves.iter_mut()) {
            let step = step.min(0.45);
            *wave = pulse(*phase, step, WIDTH);
            *phase += step;
            if *phase >= 1.0 {*phase -= 1.0;}
        }
        let tones = waves[0] * params.balance.clamp(0.0, 1.0) + waves[1];
        let strike = params.strike.clamp(0.0, 1.0);
        let envelope = self.strike.next() * strike + self.ring.next() * (1.0 - strike);
        let cut = self.cut.next();
        if (self.strike.is_idle() && self.ring.is_idle()) || self.cut.is_done() {self.active = false;}
        self.filter.process(tones, band).band * envelope * self.level * OUTPUT_GAIN * cut
    }
}

/// The power the band-pass at `color` lets through of both tones and their harmonics.
fn passed(params: &BellParams, color: f32) -> f32 {
    let mut power = 1.0e-9;
    for (frequency, amplitude) in [(params.tune, params.balance.clamp(0.0, 1.0)), (params.tune * params.ratio, 1.0)] {
        for harmonic in 1..=HARMONICS {
            let number = harmonic as f32;
            let ratio = frequency * number / color;
            let detune = 1.0 - ratio * ratio;
            let response = ratio / libm::sqrtf(detune * detune + ratio * ratio / (BAND_Q * BAND_Q));
            let partial = amplitude * libm::sinf(core::f32::consts::PI * number * WIDTH) / number * response;
            power += partial * partial;
        }
    }
    power
}

pub struct Bell {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32
}

impl Bell {
    pub fn new(sample_rate: f32) -> Self {Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0}}

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &BellParams) {
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

    pub fn process(&mut self, params: &BellParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let color = params.color.clamp(100.0, sample_rate * 0.45);
        let band = SvfCoefficients::new(color, BAND_Q, sample_rate);
        let level = libm::sqrtf(passed(&BellParams::default(), 1050.0) / passed(params, color)).min(1.0);
        let volume = libm::powf(10.0, params.volume / 20.0) * level;
        for value in output.iter_mut() {
            *value = self.voices.iter_mut().filter(|voice| voice.active)
                .map(|voice| voice.render(params, &band, sample_rate)).sum::<f32>() * volume;
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}

    voice_queries!(BellParams, RELEASE);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &BellParams, seconds: f32) -> Vec<f32> {
        let mut bell = Bell::new(RATE);
        bell.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        bell.process(params, &mut output);
        output
    }

    fn rms(samples: &[f32]) -> f32 {
        libm::sqrtf(samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32)
    }

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = BellParams {tune: 50.0, ratio: 1.0, balance: 0.0, color: 100.0, strike: 0.0, decay: 0.01,
            volume: -36.0, velocity: 0.0, play: Play::Mono};
        let high = BellParams {tune: 8000.0, ratio: 4.0, balance: 1.0, color: 16000.0, strike: 1.0, decay: 4.0,
            volume: 6.0, velocity: 1.0, play: Play::Poly};
        for params in [low, high, BellParams::default()] {
            let samples = render(&params, 1.0);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 8.0));
        }
    }

    #[test]
    fn hits_repeat_exactly() {
        let params = BellParams::default();
        let mut bell = Bell::new(RATE);
        let mut first = vec![0.0; (1.2 * RATE) as usize];
        bell.note_on(1, 1.0, 0.0, &params);
        bell.process(&params, &mut first);
        assert!(bell.is_silent());
        let mut second = vec![0.0; (1.2 * RATE) as usize];
        bell.note_on(2, 1.0, 0.0, &params);
        bell.process(&params, &mut second);
        assert_eq!(first, second);
    }

    #[test]
    fn a_band_on_a_tone_is_never_louder_than_the_808() {
        let reference = rms(&render(&BellParams {strike: 0.0, ..BellParams::default()}, 0.2));
        for (tune, ratio) in [(558.0, 1.477), (800.0, 1.0), (1500.0, 1.477)] {
            for color in [558.0, 700.0, 824.0, 1050.0, 2000.0] {
                let params = BellParams {tune, ratio, balance: 1.0, color, strike: 0.0, ..BellParams::default()};
                let level = rms(&render(&params, 0.2)) / reference;
                assert!(level < 1.6, "tune {tune} ratio {ratio} color {color}: {level}");
            }
        }
    }

    #[test]
    fn strike_falls_fast_and_the_ring_stays() {
        let window = |samples: &[f32], ms: f32| {
            rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 10.0) * RATE / 1000.0) as usize])
        };
        let hit = render(&BellParams::default(), 0.5);
        let early = window(&hit, 0.0) / window(&hit, 40.0);
        let late = window(&hit, 100.0) / window(&hit, 140.0);
        assert!(early > 3.0, "the strike is gone by 40 ms, {early}");
        assert!(late < 1.6, "then the ring fades slowly, {late}");
    }
}
