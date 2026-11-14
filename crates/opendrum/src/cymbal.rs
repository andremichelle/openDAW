//! openDrum Cymbal: the Hat's six square oscillators (scaled by Tune, Noise mixed in) through two bands. The body
//! (everything above about 2.8 kHz) swells in and rings for Decay, the top (above 6.5 kHz) starts at once and fades in
//! under half that time. Tone moves the weight from body to top. In Mono a new hit chokes the ringing one, and the
//! oscillators start every hit somewhere else in their cycles.

use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::svf::{Svf, SvfCoefficients};
use crate::common::square;
use crate::kick::Play;

pub const VOICES: usize = 4;

const SQUARES: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
// two fourth-order high-passes, the body from BODY_CUT and the top from TOP_CUT (the 808's two filter paths)
const BODY_CUT: f32 = 2000.0;
const TOP_CUT: f32 = 6500.0;
const HIGH_PASS_Q: [f32; 2] = [0.541, 1.307];
// the top fades in this share of Decay (measured 0.4 to 0.55), the body swells in over this time
const TOP_DECAY: f32 = 0.45;
const BODY_ATTACK: f32 = 0.015;
const NOISE_MATCH: f32 = 0.14;
const OUTPUT_GAIN: f32 = 3.0;
const ENVELOPE_FLOOR: f32 = 0.00001;

/// Decay in seconds, Volume in dB, Tune as a frequency ratio, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct CymbalParams {
    pub tune: f32,
    pub noise: f32,
    pub tone: f32,
    pub decay: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for CymbalParams {
    fn default() -> Self {
        Self {tune: 1.0, noise: 0.0, tone: 0.5, decay: 2.0, volume: 0.0, velocity: 0.5, play: Play::Mono}
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    id: u32,
    age: u32,
    level: f32,
    transpose: f32,
    phases: [f32; 6],
    body: HitEnvelope,
    top: HitEnvelope,
    noise: WhiteNoise,
    filters: [Svf; 4]
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &CymbalParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.id = id;
        self.age = age;
        self.level = strength;
        self.transpose = transpose;
        self.noise.reset(age.wrapping_mul(0x85EB_CA6B) ^ 0xC7B1);
        if restart {
            self.filters.iter_mut().for_each(|filter| filter.reset());
            let mut random = WhiteNoise::default();
            random.reset(age.wrapping_mul(0x9E37_79B9) ^ 0xC7B2);
            self.phases = core::array::from_fn(|_| (random.next() + 1.0) * 0.5);
        }
        let decay = params.decay.max(0.02);
        self.body.set(BODY_ATTACK, 0.0, decay, sample_rate);
        self.top.set(0.0, 0.0, decay * TOP_DECAY, sample_rate);
        for envelope in [&mut self.body, &mut self.top] {
            envelope.set_floor(ENVELOPE_FLOOR);
            if params.play == Play::Gate {envelope.trigger_held(1.0);} else {envelope.trigger(1.0);}
        }
    }

    fn release(&mut self) {
        self.body.release();
        self.top.release();
    }

    #[inline]
    fn render(&mut self, params: &CymbalParams, body: &[SvfCoefficients; 2], top: &[SvfCoefficients; 2],
              sample_rate: f32) -> f32 {
        let scale = params.tune * libm::exp2f(self.transpose / 12.0) / sample_rate;
        let mut metal = 0.0;
        for (phase, frequency) in self.phases.iter_mut().zip(SQUARES.iter()) {
            let step = (frequency * scale).min(0.45);
            metal += square(*phase, step);
            *phase += step;
            if *phase >= 1.0 {*phase -= 1.0;}
        }
        let angle = params.noise.clamp(0.0, 1.0) * core::f32::consts::FRAC_PI_2;
        let source = metal / 6.0 * libm::cosf(angle) + self.noise.next() * libm::sinf(angle) * NOISE_MATCH;
        let weight = params.tone.clamp(0.0, 1.0) * core::f32::consts::FRAC_PI_2;
        let low = self.filters[0].process(source, &body[0]).high;
        let low = self.filters[1].process(low, &body[1]).high * self.body.next() * libm::cosf(weight);
        let high = self.filters[2].process(source, &top[0]).high;
        let high = self.filters[3].process(high, &top[1]).high * self.top.next() * libm::sinf(weight);
        if self.body.is_idle() && self.top.is_idle() {self.active = false;}
        (low + high) * self.level * OUTPUT_GAIN
    }
}

pub struct Cymbal {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32
}

impl Cymbal {
    pub fn new(sample_rate: f32) -> Self {Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0}}

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &CymbalParams) {
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

    pub fn note_off(&mut self, id: u32, params: &CymbalParams) {
        if params.play != Play::Gate {return;}
        self.voices.iter_mut().filter(|voice| voice.active && voice.id == id).for_each(|voice| voice.release());
    }

    pub fn process(&mut self, params: &CymbalParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let nyquist_guard = sample_rate * 0.45;
        let body = HIGH_PASS_Q.map(|q| SvfCoefficients::new(BODY_CUT.min(nyquist_guard), q, sample_rate));
        let top = HIGH_PASS_Q.map(|q| SvfCoefficients::new(TOP_CUT.min(nyquist_guard), q, sample_rate));
        let volume = libm::powf(10.0, params.volume / 20.0);
        for value in output.iter_mut() {
            *value = self.voices.iter_mut().filter(|voice| voice.active)
                .map(|voice| voice.render(params, &body, &top, sample_rate)).sum::<f32>() * volume;
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &CymbalParams, seconds: f32) -> Vec<f32> {
        let mut cymbal = Cymbal::new(RATE);
        cymbal.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        cymbal.process(params, &mut output);
        output
    }

    fn rms(samples: &[f32]) -> f32 {
        libm::sqrtf(samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32)
    }

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = CymbalParams {tune: 0.25, noise: 0.0, tone: 0.0, decay: 0.02, volume: -36.0, velocity: 0.0,
            play: Play::Mono};
        let high = CymbalParams {tune: 4.0, noise: 1.0, tone: 1.0, decay: 8.0, volume: 0.0, velocity: 1.0,
            play: Play::Poly};
        for params in [low, high, CymbalParams::default()] {
            let samples = render(&params, 1.0);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 4.0));
        }
    }

    #[test]
    fn identical_renders() {
        let params = CymbalParams {noise: 0.5, ..CymbalParams::default()};
        assert_eq!(render(&params, 0.3), render(&params, 0.3));
    }

    #[test]
    fn the_top_fades_before_the_body() {
        let window = |samples: &[f32], ms: f32| {
            rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 50.0) * RATE / 1000.0) as usize])
        };
        let params = CymbalParams {decay: 1.0, ..CymbalParams::default()};
        let body = render(&CymbalParams {tone: 0.0, ..params}, 0.9);
        let top = render(&CymbalParams {tone: 1.0, ..params}, 0.9);
        assert!(window(&body, 600.0) / window(&body, 50.0) > window(&top, 600.0) / window(&top, 50.0) * 10.0);
    }

    #[test]
    fn two_hits_differ_and_the_second_chokes_the_first() {
        let params = CymbalParams {decay: 0.2, ..CymbalParams::default()};
        let mut cymbal = Cymbal::new(RATE);
        let mut first = vec![0.0; (0.6 * RATE) as usize];
        cymbal.note_on(1, 1.0, 0.0, &params);
        cymbal.process(&params, &mut first);
        assert!(cymbal.is_silent());
        let mut second = vec![0.0; (0.6 * RATE) as usize];
        cymbal.note_on(2, 1.0, 0.0, &params);
        cymbal.process(&params, &mut second);
        assert_ne!(first, second, "every hit starts the oscillators somewhere else");
    }
}
