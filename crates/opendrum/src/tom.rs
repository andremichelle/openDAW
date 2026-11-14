//! openDrum Tom: a tuned body that falls from Pitch to Tune over Sweep and drifts on by Drift (Shape adds the 909's
//! harmonics, stronger in the attack), a second body below it (Sub at Ratio) and a short rich one above (Top for
//! Length), the 909's three oscillators, a noise layer in a band at Color and drive.

use dsp::drum_oscillator::DrumOscillator;
use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::svf::{Svf, SvfCoefficients};
use dsp::RENDER_QUANTUM;
use crate::common::{drive_makeup, Drive, DRIVE_BIAS};
use crate::kick::Play;

pub const VOICES: usize = 16;
// Level in dB, at or below this the noise is off
pub const LEVEL_OFF: f32 = -48.0;

// harmonics 2 to 5 of each body at Shape 1, the 909 tom (measured: -20, -14, -30, -28 dB)
const SHAPE_HARMONICS: [f32; 4] = [0.1, 0.2, 0.03, 0.04];
// in the attack the main body carries more of harmonics 2, 3 and 5 (the 909's clipper runs from hard to soft)
const EDGE_HARMONICS: [f32; 3] = [0.05, 0.15, 0.25];
const EDGE_TIME: f32 = 0.06;
// the top body: its ratio above the main one and its own fixed harmonics 2 to 5 (measured 1.72 to 1.85)
const TOP_RATIO: f32 = 1.78;
const TOP_HARMONICS: [f32; 4] = [0.15, 0.15, 0.1, 0.1];
// Drift falls this many times slower than Sweep
const DRIFT_TIME: f32 = 4.0;
// the noise band runs from half its centre (LOW to LOW x RANGE over Color) up to TOP times the centre
const NOISE_CENTRE_LOW: f32 = 200.0;
const NOISE_COLOR_RANGE: f32 = 40.0;
const NOISE_TOP: f32 = 3.0;
const NOISE_GAIN: f32 = 4.0;
// Air: noise above this on the noise envelope, the top end of the hit
const AIR_HIGH: f32 = 3500.0;
const AIR_GAIN: f32 = 0.1;
const BODY_DC_BLOCK: f32 = 20.0;
const ENVELOPE_FLOOR: f32 = 0.00001;
const DRIVE_DC_BLOCK: f32 = 20.0;
const DRIVE_BIAS_FULL: f32 = 12.0;
// the drive's ceiling in engine level (a 909 tom peaks around 2), a power of two so Drive 0 stays bit exact
const DRIVE_CEILING: f32 = 4.0;

/// Times in seconds, Pitch and Drift in semitones above Tune, Noise, Drive and Volume in dB, Punch -1 to 1, Ratio
/// as a frequency ratio below the body, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct TomParams {
    pub tune: f32,
    pub pitch: f32,
    pub sweep: f32,
    pub drift: f32,
    pub decay: f32,
    pub punch: f32,
    pub shape: f32,
    pub sub: f32,
    pub ratio: f32,
    pub top: f32,
    pub length: f32,
    pub drive: f32,
    pub noise: f32,
    pub noise_decay: f32,
    pub color: f32,
    pub air: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play,
    pub glide: f32
}

impl Default for TomParams {
    fn default() -> Self {
        Self {
            tune: 110.0, pitch: 3.0, sweep: 0.03, drift: 0.0, decay: 0.5, punch: 0.0, shape: 0.0, sub: 0.0, ratio: 0.67,
            top: 0.0, length: 0.2, drive: 0.0, noise: -30.0, noise_decay: 0.3, color: 0.3, air: 0.0, volume: 0.0,
            velocity: 0.5, play: Play::Mono, glide: 0.0
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Block {
    sweep_factor: f32,
    glide_factor: f32,
    drift_factor: f32,
    noise_high: SvfCoefficients,
    noise_low: SvfCoefficients,
    air_high: SvfCoefficients,
    noise_level: f32,
    dc_coefficient: f32
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    id: u32,
    age: u32,
    level: f32,
    transpose: f32,
    slide: f32,
    gated: bool,
    bend: f32,
    drift: f32,
    elapsed: u32,
    bodies: [DrumOscillator; 3],
    amp: HitEnvelope,
    top_amp: HitEnvelope,
    edge: HitEnvelope,
    noise_amp: HitEnvelope,
    dc_input: f32,
    dc_output: f32,
    noise: WhiteNoise,
    noise_filters: [Svf; 3]
}

impl Voice {
    fn set_envelopes(&mut self, params: &TomParams, sample_rate: f32) {
        self.amp.set(0.0, 0.0, params.decay, sample_rate);
        self.amp.set_curve(params.punch);
        self.noise_amp.set(0.0, 0.0, params.noise_decay, sample_rate);
        self.top_amp.set(0.0, 0.0, params.length, sample_rate);
        self.edge.set(0.0, 0.0, EDGE_TIME, sample_rate);
        self.amp.set_floor(ENVELOPE_FLOOR);
        self.noise_amp.set_floor(ENVELOPE_FLOOR);
    }

    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &TomParams, held: bool,
             sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.id = id;
        self.age = age;
        self.level = strength;
        self.transpose = transpose;
        self.slide = 0.0;
        self.gated = held;
        self.bend = libm::exp2f(params.pitch * (0.5 + 0.5 * strength) / 12.0) - 1.0;
        self.drift = libm::exp2f(params.drift / 12.0) - 1.0;
        self.elapsed = 0;
        self.bodies.iter_mut().for_each(|body| body.reset(0.0));
        self.noise.reset(age.wrapping_mul(0x85EB_CA6B) ^ 0x70A2);
        if restart {self.noise_filters.iter_mut().for_each(|filter| filter.reset());}
        self.set_envelopes(params, sample_rate);
        for envelope in [&mut self.amp, &mut self.noise_amp] {
            if held {envelope.trigger_held(1.0);} else {envelope.trigger(1.0);}
        }
        self.top_amp.trigger(1.0);
        self.edge.trigger(1.0);
    }

    fn release(&mut self) {
        self.gated = false;
        self.amp.release();
        self.noise_amp.release();
    }

    #[inline]
    fn render(&mut self, params: &TomParams, block: &Block, sample_rate: f32) -> f32 {
        self.elapsed = self.elapsed.saturating_add(1);
        let key = params.tune * libm::exp2f((self.transpose + self.slide) / 12.0);
        let frequency = key * (1.0 + self.bend + self.drift);
        self.slide *= block.glide_factor;
        self.bend *= block.sweep_factor;
        self.drift *= block.drift_factor;
        let sine = self.bodies[0].sine(frequency, sample_rate);
        let main = bend(sine, params.shape, &SHAPE_HARMONICS) + edge(sine) * params.shape * self.edge.next();
        let sub = bend(self.bodies[1].sine(frequency * params.ratio, sample_rate), params.shape, &SHAPE_HARMONICS);
        let top = bend(self.bodies[2].sine(frequency * TOP_RATIO, sample_rate), 1.0, &TOP_HARMONICS);
        let bodies = (main + sub * params.sub) * self.amp.next() + top * params.top * self.top_amp.next();
        self.dc_output = bodies - self.dc_input + block.dc_coefficient * self.dc_output;
        self.dc_input = bodies;
        let mut value = self.dc_output;
        let white = self.noise.next();
        let band = self.noise_filters[0].process(white, &block.noise_high).high;
        let band = self.noise_filters[1].process(band, &block.noise_low).low;
        let noise_amp = self.noise_amp.next();
        let air = self.noise_filters[2].process(white, &block.air_high).high * params.air * AIR_GAIN;
        value += (band * block.noise_level + air) * noise_amp;
        if self.amp.is_idle() && self.noise_amp.is_idle() && self.top_amp.is_idle() {self.active = false;}
        value * self.level
    }
}

/// Shapes a body's full level sine with Chebyshev polynomials, each adds exactly one harmonic.
#[inline]
fn bend(value: f32, shape: f32, harmonics: &[f32; 4]) -> f32 {
    if shape <= 0.0 {return value;}
    let square = value * value;
    let second = 2.0 * square - 1.0;
    let third = value * (4.0 * square - 3.0);
    let fourth = 8.0 * square * (square - 1.0) + 1.0;
    let fifth = value * (16.0 * square * square - 20.0 * square + 5.0);
    let [a, b, c, d] = *harmonics;
    value + shape * (a * second + b * third + c * fourth + d * fifth)
}

/// Harmonics 2, 3 and 5 of a full level sine, the extra edge of the attack.
#[inline]
fn edge(value: f32) -> f32 {
    let square = value * value;
    let [a, b, c] = EDGE_HARMONICS;
    let fifth = value * (16.0 * square * square - 20.0 * square + 5.0);
    a * (2.0 * square - 1.0) + b * value * (4.0 * square - 3.0) + c * fifth
}

pub struct Tom {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32,
    drive: Drive,
    dry: [f32; RENDER_QUANTUM]
}

impl Tom {
    pub fn new(sample_rate: f32) -> Self {
        Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0, drive: Drive::new(DRIVE_DC_BLOCK),
            dry: [0.0; RENDER_QUANTUM]}
    }

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &TomParams) {
        self.hits = self.hits.wrapping_add(1);
        let strength = 1.0 - params.velocity * (1.0 - velocity.clamp(0.0, 1.0));
        let index = match params.play {
            Play::Poly => self.voices.iter().position(|voice| !voice.active).unwrap_or_else(|| {
                (0..VOICES).min_by_key(|index| self.voices[*index].age).unwrap_or(0)
            }),
            _ => 0
        };
        let (hits, sample_rate) = (self.hits, self.sample_rate);
        let voice = &mut self.voices[index];
        let previous = voice.transpose + voice.slide;
        let sliding = params.play != Play::Poly && voice.active && params.glide > 0.0;
        if params.play == Play::Gate && voice.active && voice.gated {
            voice.id = id;
            voice.slide = if params.glide > 0.0 {previous - transpose} else {0.0};
            voice.transpose = transpose;
            return;
        }
        voice.start(id, hits, strength, transpose, params, params.play == Play::Gate, sample_rate);
        if sliding {voice.slide = previous - transpose;}
    }

    pub fn note_off(&mut self, id: u32, params: &TomParams) {
        if params.play != Play::Gate {return;}
        self.voices.iter_mut().filter(|voice| voice.active && voice.id == id).for_each(|voice| voice.release());
    }

    pub fn process(&mut self, params: &TomParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let centre = NOISE_CENTRE_LOW * libm::powf(NOISE_COLOR_RANGE, params.color.clamp(0.0, 1.0));
        let nyquist_guard = sample_rate * 0.45;
        let level = if params.noise <= LEVEL_OFF {0.0} else {libm::powf(10.0, params.noise / 20.0) * NOISE_GAIN};
        let block = Block {
            sweep_factor: libm::expf(-1.0 / (params.sweep.max(0.0005) * sample_rate)),
            glide_factor: if params.glide > 0.0 {libm::expf(-3.0 / (params.glide * sample_rate))} else {0.0},
            drift_factor: libm::expf(-1.0 / (params.sweep.max(0.0005) * DRIFT_TIME * sample_rate)),
            noise_high: SvfCoefficients::new((centre * 0.5).min(nyquist_guard), 0.707, sample_rate),
            noise_low: SvfCoefficients::new((centre * NOISE_TOP).min(nyquist_guard), 0.5, sample_rate),
            noise_level: level,
            air_high: SvfCoefficients::new(AIR_HIGH.min(nyquist_guard), 0.707, sample_rate),
            dc_coefficient: 1.0 - 2.0 * core::f32::consts::PI * BODY_DC_BLOCK / sample_rate
        };
        let level = libm::powf(10.0, params.volume / 20.0) * DRIVE_CEILING * drive_makeup(params.drive);
        let bias = DRIVE_BIAS * (params.drive / DRIVE_BIAS_FULL).clamp(0.0, 1.0);
        for voice in self.voices.iter_mut().filter(|voice| voice.active) {voice.set_envelopes(params, sample_rate);}
        for chunk in output.chunks_mut(RENDER_QUANTUM) {
            let frames = chunk.len();
            for frame in 0..frames {
                let mix: f32 = self.voices.iter_mut().filter(|voice| voice.active)
                    .map(|voice| voice.render(params, &block, sample_rate)).sum();
                self.dry[frame] = mix / DRIVE_CEILING;
            }
            self.drive.process(params.drive, bias, sample_rate, &self.dry, chunk);
            chunk.iter_mut().for_each(|value| *value *= level);
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &TomParams, seconds: f32) -> Vec<f32> {
        let mut tom = Tom::new(RATE);
        tom.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        tom.process(params, &mut output);
        output
    }

    fn crossings(samples: &[f32]) -> usize {samples.windows(2).filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0).count()}

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = TomParams {tune: 40.0, pitch: 0.0, sweep: 0.001, drift: 0.0, decay: 0.02, punch: -1.0, shape: 0.0,
            sub: 0.0, ratio: 0.5, top: 0.0, length: 0.02, drive: 0.0, noise: LEVEL_OFF, noise_decay: 0.02, color: 0.0, air: 0.0,
            volume: -36.0, velocity: 0.0, play: Play::Mono, glide: 0.0};
        let high = TomParams {tune: 800.0, pitch: 24.0, sweep: 0.2, drift: 12.0, decay: 3.0, punch: 1.0, shape: 1.0,
            sub: 1.0, ratio: 1.0, top: 1.0, length: 1.0, drive: 36.0, noise: 0.0, noise_decay: 3.0, color: 1.0, air: 1.0,
            volume: 0.0, velocity: 1.0, play: Play::Poly, glide: 1.0};
        for params in [low, high, TomParams::default()] {
            let samples = render(&params, 3.5);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 8.0));
        }
    }

    #[test]
    fn identical_renders() {
        let params = TomParams {top: 0.5, shape: 0.5, sub: 0.3, ..TomParams::default()};
        assert_eq!(render(&params, 0.5), render(&params, 0.5));
    }

    #[test]
    fn the_body_falls_from_pitch_to_tune() {
        let params = TomParams {tune: 100.0, pitch: 12.0, sweep: 0.02, decay: 1.0, noise: LEVEL_OFF,
            ..TomParams::default()};
        let samples = render(&params, 0.6);
        let early = crossings(&samples[..(0.02 * RATE) as usize]) as f32 / 0.02;
        let late = crossings(&samples[(0.3 * RATE) as usize..(0.5 * RATE) as usize]) as f32 / 0.2;
        assert!(early > 140.0, "{early}");
        assert!((late - 100.0).abs() < 6.0, "{late}");
    }

    #[test]
    fn ends_silent_after_the_longest_decay() {
        let params = TomParams {decay: 0.2, noise_decay: 0.1, ..TomParams::default()};
        let mut tom = Tom::new(RATE);
        tom.note_on(1, 1.0, 0.0, &params);
        let mut output = vec![0.0; (0.4 * RATE) as usize];
        tom.process(&params, &mut output);
        assert!(tom.is_silent());
    }

    #[test]
    fn sub_adds_a_tone_below() {
        let params = TomParams {tune: 300.0, pitch: 0.0, noise: LEVEL_OFF, ratio: 0.5, ..TomParams::default()};
        let energy = |samples: &[f32]| samples.iter().map(|value| value * value).sum::<f32>();
        let plain = energy(&render(&params, 0.1));
        let with_sub = energy(&render(&TomParams {sub: 1.0, ..params}, 0.1));
        assert!(with_sub > plain * 1.7, "an equally loud second tone doubles the energy");
    }
}
