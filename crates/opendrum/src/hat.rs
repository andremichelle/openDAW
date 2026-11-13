//! openDrum Hat: six square oscillators at the 808's frequencies (scaled by Tune) with Noise mixed in, a steep
//! high-pass at Color and a fixed low-pass above. One envelope: Hold at full level, then Decay. In Mono a new hit chokes
//! the ringing one.

use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::svf::{Svf, SvfCoefficients};
use crate::kick::Play;

pub const VOICES: usize = 8;

// the 808's six oscillators in Hz
const SQUARES: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
// fourth-order Butterworth high-pass
const HIGH_PASS_Q: [f32; 2] = [0.541, 1.307];
// the low-pass above, between the 808's closed (about 18 kHz) and open hat (about 11 kHz)
const TOP: f32 = 14000.0;
const OUTPUT_GAIN: f32 = 3.5;
// plain noise carries this much less than 1 to be as loud as the squares behind the filters
const NOISE_MATCH: f32 = 0.14;
const ENVELOPE_FLOOR: f32 = 0.00001;

/// Times in seconds, Color in Hz, Volume in dB, Tune as a frequency ratio, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct HatParams {
    pub tune: f32,
    pub noise: f32,
    pub color: f32,
    pub hold: f32,
    pub decay: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for HatParams {
    fn default() -> Self {
        Self {
            tune: 1.0, noise: 0.0, color: 7000.0, hold: 0.0, decay: 0.12, volume: 0.0, velocity: 0.5,
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
    phases: [f32; 6],
    amp: HitEnvelope,
    noise: WhiteNoise,
    filters: [Svf; 3]
}

/// A band-limited square (polyBLEP) from a phase in 0 to 1 advancing by `step`.
#[inline]
fn square(phase: f32, step: f32) -> f32 {
    let blep = |position: f32| {
        if position < step {
            let ratio = position / step;
            ratio + ratio - ratio * ratio - 1.0
        } else if position > 1.0 - step {
            let ratio = (position - 1.0) / step;
            ratio * ratio + ratio + ratio + 1.0
        } else {0.0}
    };
    let half = if phase < 0.5 {phase + 0.5} else {phase - 0.5};
    (if phase < 0.5 {1.0} else {-1.0}) + blep(phase) - blep(half)
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &HatParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.id = id;
        self.age = age;
        self.level = strength;
        self.transpose = transpose;
        self.noise.reset(age.wrapping_mul(0x85EB_CA6B) ^ 0x4A71);
        if restart {
            self.filters.iter_mut().for_each(|filter| filter.reset());
            self.phases = [0.0; 6];
        }
        self.amp.set(0.0, params.hold.max(0.0), params.decay.max(0.005), sample_rate);
        self.amp.set_floor(ENVELOPE_FLOOR);
        if params.play == Play::Gate {self.amp.trigger_held(1.0);} else {self.amp.trigger(1.0);}
    }

    #[inline]
    fn render(&mut self, params: &HatParams, high: &[SvfCoefficients; 2], low: &SvfCoefficients,
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
        let filtered = self.filters[0].process(source, &high[0]).high;
        let filtered = self.filters[1].process(filtered, &high[1]).high;
        let filtered = self.filters[2].process(filtered, low).low;
        let value = filtered * self.amp.next();
        if self.amp.is_idle() {self.active = false;}
        value * self.level * OUTPUT_GAIN
    }
}

pub struct Hat {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32
}

impl Hat {
    pub fn new(sample_rate: f32) -> Self {Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0}}

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &HatParams) {
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

    pub fn note_off(&mut self, id: u32, params: &HatParams) {
        if params.play != Play::Gate {return;}
        self.voices.iter_mut().filter(|voice| voice.active && voice.id == id).for_each(|voice| voice.amp.release());
    }

    pub fn process(&mut self, params: &HatParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let nyquist_guard = sample_rate * 0.45;
        let high = HIGH_PASS_Q.map(|q| SvfCoefficients::new(params.color.clamp(200.0, nyquist_guard), q, sample_rate));
        let low = SvfCoefficients::new(TOP.min(nyquist_guard), 0.707, sample_rate);
        let volume = libm::powf(10.0, params.volume / 20.0);
        for value in output.iter_mut() {
            *value = self.voices.iter_mut().filter(|voice| voice.active)
                .map(|voice| voice.render(params, &high, &low, sample_rate)).sum::<f32>() * volume;
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &HatParams, seconds: f32) -> Vec<f32> {
        let mut hat = Hat::new(RATE);
        hat.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        hat.process(params, &mut output);
        output
    }

    fn rms(samples: &[f32]) -> f32 {
        libm::sqrtf(samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32)
    }

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = HatParams {tune: 0.25, noise: 0.0, color: 200.0, hold: 0.0, decay: 0.005,
            volume: -36.0, velocity: 0.0, play: Play::Mono};
        let high = HatParams {tune: 4.0, noise: 1.0, color: 16000.0, hold: 0.5, decay: 4.0,
            volume: 0.0, velocity: 1.0, play: Play::Poly};
        for params in [low, high, HatParams::default()] {
            let samples = render(&params, 1.0);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 4.0));
        }
    }

    #[test]
    fn identical_renders() {
        let params = HatParams {noise: 0.5, ..HatParams::default()};
        assert_eq!(render(&params, 0.3), render(&params, 0.3));
    }

    #[test]
    fn hold_and_decay_open_the_hat() {
        let closed = render(&HatParams::default(), 0.5);
        let open = render(&HatParams {hold: 0.03, decay: 0.6, ..HatParams::default()}, 0.5);
        let window = |samples: &[f32], ms: f32| {
            rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 20.0) * RATE / 1000.0) as usize])
        };
        assert!(window(&open, 200.0) > window(&closed, 200.0) * 20.0, "the open hat still rings at 200 ms");
        assert!(window(&open, 20.0) > window(&open, 0.0) * 0.7, "and holds its level at first");
    }

    #[test]
    fn a_new_hit_chokes_the_open_hat_in_mono() {
        let open = HatParams {hold: 0.03, decay: 0.6, ..HatParams::default()};
        let mut hat = Hat::new(RATE);
        hat.note_on(1, 1.0, 0.0, &open);
        let mut output = vec![0.0; (0.1 * RATE) as usize];
        hat.process(&open, &mut output);
        let closed = HatParams::default();
        hat.note_on(2, 1.0, 0.0, &closed);
        let mut after = vec![0.0; (0.3 * RATE) as usize];
        hat.process(&closed, &mut after);
        assert!(hat.is_silent(), "the closed hit replaced the open one and has ended");
    }
}
