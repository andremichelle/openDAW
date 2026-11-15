//! openDrum Perc: a sine carrier at Tune, phase modulated by a sine at Tune x Ratio. Index is the modulation depth,
//! falling over Bite, Pitch is where the hit starts above (or below) Tune, falling back over Sweep. Noise mixes in
//! white noise, Drive saturates. Covers zaps, lasers, blips, metallic and industrial hits. Velocity moves the level
//! and the Index. Every hit repeats exactly, glitches come from modulators.

use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::RENDER_QUANTUM;
use crate::common::{drive_makeup, Cut, Drive, DRIVE_BIAS};
use crate::common::Play;

pub const VOICES: usize = 8;

// Index at 1 is this many radians of phase modulation
const INDEX_RANGE: f32 = 8.0;
const DRIVE_DC_BLOCK: f32 = 20.0;
const DRIVE_BIAS_FULL: f32 = 12.0;
// the drive's ceiling in engine level, a power of two so Drive 0 stays bit exact
const DRIVE_CEILING: f32 = 2.0;
const NOISE_SEED: u32 = 0x5EC7;
const ENVELOPE_FLOOR: f32 = 0.00001;
// in Gate a hit ends this fast when its note ends
const RELEASE: f32 = 0.005;

/// Tune in Hz, Ratio as a frequency ratio, Pitch in semitones, times in seconds, Drive and Volume in dB, Curve -1 to
/// 1, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct PercParams {
    pub tune: f32,
    pub ratio: f32,
    pub index: f32,
    pub bite: f32,
    pub pitch: f32,
    pub sweep: f32,
    pub decay: f32,
    pub curve: f32,
    pub noise: f32,
    pub drive: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play
}

impl Default for PercParams {
    fn default() -> Self {
        Self {
            tune: 220.0, ratio: 2.0, index: 0.3, bite: 0.05, pitch: 24.0, sweep: 0.03, decay: 0.25, curve: 0.0,
            noise: 0.0, drive: 0.0, volume: 0.0, velocity: 0.5, play: Play::Mono
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
    depth: f32,
    transpose: f32,
    bend: f32,
    carrier: f32,
    modulator: f32,
    amp: HitEnvelope,
    index: HitEnvelope,
    noise: WhiteNoise,
    cut: Cut
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &PercParams, sample_rate: f32) {
        let restart = !self.active;
        self.active = true;
        self.elapsed = 0;
        self.cut.reset();
        self.id = id;
        self.age = age;
        self.level = strength;
        self.depth = strength;
        self.transpose = transpose;
        self.bend = params.pitch;
        if restart {
            self.carrier = 0.0;
            self.modulator = 0.0;
        }
        self.noise.reset(NOISE_SEED);
        self.amp.set(0.0, 0.0, params.decay.max(0.005), sample_rate);
        self.amp.set_curve(params.curve);
        self.index.set(0.0, 0.0, params.bite.max(0.001), sample_rate);
        for envelope in [&mut self.amp, &mut self.index] {
            envelope.set_floor(ENVELOPE_FLOOR);
            envelope.trigger(1.0);
        }
    }

    #[inline]
    fn render(&mut self, params: &PercParams, sweep_factor: f32, sample_rate: f32) -> f32 {
        self.elapsed = self.elapsed.saturating_add(1);
        let frequency = params.tune * libm::exp2f((self.transpose + self.bend) / 12.0);
        self.bend *= sweep_factor;
        let step = (frequency / sample_rate).min(0.45);
        let modulation = libm::sinf(core::f32::consts::TAU * self.modulator)
            * params.index.clamp(0.0, 1.0) * INDEX_RANGE * self.depth * self.index.next();
        let tone = libm::sinf(core::f32::consts::TAU * self.carrier + modulation);
        self.carrier += step;
        if self.carrier >= 1.0 {self.carrier -= 1.0;}
        self.modulator += (step * params.ratio.max(0.0)).min(0.45);
        if self.modulator >= 1.0 {self.modulator -= libm::floorf(self.modulator);}
        let noise = params.noise.clamp(0.0, 1.0);
        let value = (tone + (self.noise.next() - tone) * noise) * self.amp.next();
        let cut = self.cut.next();
        if self.amp.is_idle() || self.cut.is_done() {self.active = false;}
        value * self.level * cut
    }
}

pub struct Perc {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32,
    drive: Drive,
    dry: [f32; RENDER_QUANTUM]
}

impl Perc {
    pub fn new(sample_rate: f32) -> Self {
        Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0, drive: Drive::new(DRIVE_DC_BLOCK),
            dry: [0.0; RENDER_QUANTUM]}
    }

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &PercParams) {
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

    pub fn process(&mut self, params: &PercParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let sweep_factor = libm::expf(-1.0 / (params.sweep.max(0.0005) * sample_rate));
        let level = libm::powf(10.0, params.volume / 20.0) * DRIVE_CEILING * drive_makeup(params.drive);
        let bias = DRIVE_BIAS * (params.drive / DRIVE_BIAS_FULL).clamp(0.0, 1.0);
        for chunk in output.chunks_mut(RENDER_QUANTUM) {
            let frames = chunk.len();
            for frame in 0..frames {
                let mix: f32 = self.voices.iter_mut().filter(|voice| voice.active)
                    .map(|voice| voice.render(params, sweep_factor, sample_rate)).sum();
                self.dry[frame] = mix / DRIVE_CEILING;
            }
            self.drive.process(params.drive, bias, sample_rate, &self.dry, chunk);
            chunk.iter_mut().for_each(|value| *value *= level);
        }
    }

    pub fn is_silent(&self) -> bool {self.voices.iter().all(|voice| !voice.active)}

    voice_queries!(PercParams, RELEASE);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &PercParams, seconds: f32) -> Vec<f32> {
        let mut perc = Perc::new(RATE);
        perc.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        perc.process(params, &mut output);
        output
    }

    fn rising_crossings(samples: &[f32]) -> usize {
        samples.windows(2).filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0).count()
    }

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = PercParams {tune: 20.0, ratio: 0.25, index: 0.0, bite: 0.001, pitch: -48.0, sweep: 0.0005,
            decay: 0.005, curve: -1.0, noise: 0.0, drive: 0.0, volume: -36.0, velocity: 0.0, play: Play::Mono};
        let high = PercParams {tune: 8000.0, ratio: 16.0, index: 1.0, bite: 2.0, pitch: 48.0, sweep: 2.0,
            decay: 4.0, curve: 1.0, noise: 1.0, drive: 36.0, volume: 6.0, velocity: 1.0, play: Play::Poly};
        for params in [low, high, PercParams::default()] {
            let samples = render(&params, 1.0);
            assert!(samples.iter().all(|value| value.is_finite() && value.abs() < 4.0));
        }
    }

    #[test]
    fn hits_repeat_exactly() {
        let params = PercParams {noise: 0.3, ..PercParams::default()};
        let mut perc = Perc::new(RATE);
        let mut first = vec![0.0; (0.5 * RATE) as usize];
        perc.note_on(1, 1.0, 0.0, &params);
        perc.process(&params, &mut first);
        assert!(perc.is_silent());
        let mut second = vec![0.0; (0.5 * RATE) as usize];
        perc.note_on(2, 1.0, 0.0, &params);
        perc.process(&params, &mut second);
        assert_eq!(first, second);
    }

    #[test]
    fn pitch_falls_back_to_tune() {
        let params = PercParams {index: 0.0, pitch: 24.0, sweep: 0.01, decay: 1.0, ..PercParams::default()};
        let samples = render(&params, 0.5);
        let early = rising_crossings(&samples[..(0.01 * RATE) as usize]) as f32 / 0.01;
        let late = rising_crossings(&samples[(0.3 * RATE) as usize..(0.4 * RATE) as usize]) as f32 / 0.1;
        assert!(early > 440.0, "starts well above Tune, {early} Hz");
        assert!((late - 220.0).abs() < 15.0, "ends at Tune, {late} Hz");
    }

    #[test]
    fn index_adds_overtones_that_fall_with_bite() {
        let plain = render(&PercParams {index: 0.0, pitch: 0.0, ..PercParams::default()}, 0.3);
        let bright = render(&PercParams {index: 1.0, pitch: 0.0, bite: 0.05, ..PercParams::default()}, 0.3);
        let roughness = |samples: &[f32]| samples.windows(2).map(|pair| (pair[1] - pair[0]).abs()).sum::<f32>()
            / samples.iter().map(|value| value.abs()).sum::<f32>();
        let window = |samples: &[f32], ms: f32| {
            samples[(ms * RATE / 1000.0) as usize..((ms + 20.0) * RATE / 1000.0) as usize].to_vec()
        };
        assert!(roughness(&window(&bright, 0.0)) > roughness(&window(&plain, 0.0)) * 2.0, "Index brightens");
        assert!(roughness(&window(&bright, 200.0)) < roughness(&window(&bright, 0.0)) * 0.6, "and falls with Bite");
    }
}
