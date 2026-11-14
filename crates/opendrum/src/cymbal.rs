//! openDrum Cymbal: the Hat's six square oscillators (scaled by Tune) in three parts. The body (around 2 to 5 kHz)
//! swells in and rings for Decay, the top (above 5 kHz with a peak near 6.5 kHz) starts at once and fades sooner,
//! the sizzle (above 9 kHz) rings as long as the top. Tone raises the sizzle and lowers the body. Attack fades all
//! parts in (the body never faster than its own swell). In Mono a new hit chokes the ringing one, and the
//! oscillators start every hit somewhere else in their cycles.

use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::svf::{Svf, SvfCoefficients};
use crate::common::square;
use crate::kick::Play;

pub const VOICES: usize = 4;

const SQUARES: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
// the body's band: a fourth-order high-pass, then a gentle low-pass
const BODY_LOW: f32 = 2600.0;
const BODY_LOW_Q: [f32; 2] = [0.541, 1.307];
const BODY_HIGH: f32 = 4500.0;
const BODY_ATTACK: f32 = 0.04;
const BODY_CURVE: f32 = 1.0;
const BODY_GAIN: f32 = 0.2;
// the top: a fourth-order high-pass whose second stage is resonant (the references peak near 6.5 kHz)
const TOP_CUT: f32 = 6000.0;
const TOP_Q: [f32; 2] = [0.541, 2.0];
// the top fades in TOP_TIME x Decay^TOP_POWER (0.85 s at a Decay of 1 s, about 2.2 s at 5 s)
const TOP_TIME: f32 = 0.85;
const TOP_POWER: f32 = 0.6;
const SIZZLE_CUT: f32 = 9000.0;
const SIZZLE_GAIN: f32 = 1.5;
// Tone at 1 turns the body down by this share
const BODY_TONE: f32 = 0.4;
const OUTPUT_GAIN: f32 = 3.0;
const ENVELOPE_FLOOR: f32 = 0.00001;

/// Attack and Decay in seconds, Volume in dB, Tune as a frequency ratio, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct CymbalParams {
    pub tune: f32,
    pub tone: f32,
    pub attack: f32,
    pub decay: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for CymbalParams {
    fn default() -> Self {
        Self {tune: 1.0, tone: 0.3, attack: 0.0, decay: 1.0, volume: 0.0, velocity: 0.5, play: Play::Mono}
    }
}

#[derive(Clone, Copy, Default)]
struct Filters {
    body_low: [SvfCoefficients; 2],
    body_high: SvfCoefficients,
    top: [SvfCoefficients; 2],
    sizzle: SvfCoefficients
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
    sizzle: HitEnvelope,
    filters: [Svf; 6]
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &CymbalParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.id = id;
        self.age = age;
        self.level = strength;
        self.transpose = transpose;
        if restart {
            self.filters.iter_mut().for_each(|filter| filter.reset());
            let mut random = WhiteNoise::default();
            random.reset(age.wrapping_mul(0x9E37_79B9) ^ 0xC7B2);
            self.phases = core::array::from_fn(|_| (random.next() + 1.0) * 0.5);
        }
        let decay = params.decay.max(0.05);
        let attack = params.attack.max(0.0);
        self.body.set(BODY_ATTACK.min(decay * 0.25).max(attack), 0.0, decay, sample_rate);
        self.body.set_curve(BODY_CURVE);
        let top = TOP_TIME * libm::powf(decay, TOP_POWER);
        self.top.set(attack, 0.0, top, sample_rate);
        self.sizzle.set(attack, 0.0, top, sample_rate);
        for envelope in [&mut self.body, &mut self.top, &mut self.sizzle] {
            envelope.set_floor(ENVELOPE_FLOOR);
            if params.play == Play::Gate {envelope.trigger_held(1.0);} else {envelope.trigger(1.0);}
        }
    }

    fn release(&mut self) {
        self.body.release();
        self.top.release();
        self.sizzle.release();
    }

    #[inline]
    fn render(&mut self, params: &CymbalParams, filters: &Filters, sample_rate: f32) -> f32 {
        let scale = params.tune * libm::exp2f(self.transpose / 12.0) / sample_rate;
        let mut metal = 0.0;
        for (phase, frequency) in self.phases.iter_mut().zip(SQUARES.iter()) {
            let step = (frequency * scale).min(0.45);
            metal += square(*phase, step);
            *phase += step;
            if *phase >= 1.0 {*phase -= 1.0;}
        }
        let metal = metal / 6.0;
        let body = self.filters[0].process(metal, &filters.body_low[0]).high;
        let body = self.filters[1].process(body, &filters.body_low[1]).high;
        let tone = params.tone.clamp(0.0, 1.0);
        let body = self.filters[2].process(body, &filters.body_high).low * self.body.next() * BODY_GAIN
            * (1.0 - tone * BODY_TONE);
        let top = self.filters[3].process(metal, &filters.top[0]).high;
        let top = self.filters[4].process(top, &filters.top[1]).high * self.top.next();
        let sizzle = self.filters[5].process(metal, &filters.sizzle).high * self.sizzle.next() * tone * SIZZLE_GAIN;
        if self.body.is_idle() && self.top.is_idle() && self.sizzle.is_idle() {self.active = false;}
        (body + top + sizzle) * self.level * OUTPUT_GAIN
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
        let limit = |frequency: f32| frequency.min(sample_rate * 0.45);
        let filters = Filters {
            body_low: BODY_LOW_Q.map(|q| SvfCoefficients::new(limit(BODY_LOW), q, sample_rate)),
            body_high: SvfCoefficients::new(limit(BODY_HIGH), 0.5, sample_rate),
            top: TOP_Q.map(|q| SvfCoefficients::new(limit(TOP_CUT), q, sample_rate)),
            sizzle: SvfCoefficients::new(limit(SIZZLE_CUT), 0.707, sample_rate)
        };
        let volume = libm::powf(10.0, params.volume / 20.0);
        for value in output.iter_mut() {
            *value = self.voices.iter_mut().filter(|voice| voice.active)
                .map(|voice| voice.render(params, &filters, sample_rate)).sum::<f32>() * volume;
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
        let low = CymbalParams {tune: 0.25, tone: 0.0, attack: 0.0, decay: 0.05,
            volume: -36.0, velocity: 0.0, play: Play::Mono};
        let high = CymbalParams {tune: 4.0, tone: 1.0, attack: 2.0, decay: 8.0,
            volume: 0.0, velocity: 1.0, play: Play::Poly};
        for params in [low, high, CymbalParams::default()] {
            let samples = render(&params, 1.0);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 4.0));
        }
    }

    #[test]
    fn identical_renders() {
        let params = CymbalParams {tone: 0.5, ..CymbalParams::default()};
        assert_eq!(render(&params, 0.3), render(&params, 0.3));
    }

    #[test]
    fn tone_brightens_the_whole_hit() {
        let window = |samples: &[f32], ms: f32| {
            rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 30.0) * RATE / 1000.0) as usize])
        };
        let plain = render(&CymbalParams {tone: 0.0, decay: 1.0, ..CymbalParams::default()}, 0.8);
        let bright = render(&CymbalParams {tone: 1.0, decay: 1.0, ..CymbalParams::default()}, 0.8);
        assert!(window(&bright, 0.0) > window(&plain, 0.0) * 1.5, "Tone adds to the start");
        assert!(window(&bright, 200.0) > window(&plain, 200.0) * 1.2, "and lasts");
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

    #[test]
    fn attack_fades_the_hit_in() {
        let window = |samples: &[f32], ms: f32| {
            rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 10.0) * RATE / 1000.0) as usize])
        };
        let swell = render(&CymbalParams {attack: 0.3, ..CymbalParams::default()}, 0.6);
        assert!(window(&swell, 0.0) * 4.0 < window(&swell, 290.0), "quiet at first, full at the end of Attack");
    }
}
