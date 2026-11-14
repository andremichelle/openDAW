//! openDrum Snare: two tuned bodies (the second at Ratio above the first, Balance between them) that fall from
//! Pitch to Tune over Sweep (Shape adds their harmonics), wires (noise in a band, Width spreading it from
//! narrow to wide with a resonant top, whose envelope Curve runs from a long tail to the 909's held steam valve with
//! its short burst and low noise under the bodies), the shared click, membrane overtones (Skin) and drive. The
//! parameter set is frozen (plans/drum-engines.md).

use dsp::drum_oscillator::DrumOscillator;
use dsp::hit_envelope::HitEnvelope;
use dsp::noise::WhiteNoise;
use dsp::resonator::{Resonator, ResonatorCoefficients};
use dsp::svf::{Svf, SvfCoefficients};
use dsp::RENDER_QUANTUM;
use crate::common::{drive_makeup, Click, ClickShape, Drive, CLICK_LENGTH, DRIVE_BIAS};
use crate::kick::Play;

pub const VOICES: usize = 16;

const SKIN_RATIOS: [f32; 4] = [1.59, 2.14, 2.30, 2.65];
const SKIN_GAIN: f32 = 0.35;
const CLICK_NOISE_MIX: f32 = 0.5;
// the noise band's centre, between the 808's (3.55 kHz) and the 909's (3.0 kHz)
const WIRE_CENTRE: f32 = 3300.0;
const WIRE_GAIN: f32 = 1.5;
// Width spreads the high-pass and the resonant low-pass around the centre: 808 narrow and plain, 909 wide with a
// peak at the top (fitted on both references)
const WIRE_SPAN: [f32; 2] = [1.5, 12.0];
const WIRE_RESONANCE: [f32; 2] = [0.6, 2.0];
const WIRE_HIGH_PASS_Q: f32 = 0.707;
// the Level stays put over Width and Color: the gain follows the passed band (in Hz) against this one
const WIRE_REFERENCE_BAND: f32 = 4000.0;
// a positive Curve adds the 909's short broad noise burst on the attack
const SNAP_CUT: f32 = 4000.0;
const SNAP_TIME: f32 = 0.004;
const SNAP_GAIN: f32 = 12.0;
// a positive Curve also adds the 909's low-passed noise burst under the bodies
const LOW_CUT: f32 = 700.0;
const LOW_HOLD: f32 = 0.008;
const LOW_TIME: f32 = 0.008;
const LOW_BURST: f32 = 16.0;
// Level in dB, at or below this the wires are off
pub const LEVEL_OFF: f32 = -48.0;
pub const LEVEL_MAX: f32 = -3.0;
// a positive Curve holds the wires at the top for up to this share of their decay before the straight fall
const WIRE_HOLD: f32 = 0.25;
// the envelopes ring on to -100 dB, the 808 keeps a quiet tail far below the usual -66 dB stop
const ENVELOPE_FLOOR: f32 = 0.00001;
// a negative Curve adds a quiet second stage under the wires, four times longer (the 808's slow noise tail)
const TAIL_LEVEL: f32 = 0.06;
const TAIL_TIME: f32 = 4.0;
// harmonics 2, 3 and 4 of each body at Shape 1, twice the 909's (measured on its noise-free snares)
const SHAPE_HARMONICS: [f32; 3] = [0.29, 0.125, 0.052];
const BODY_DC_BLOCK: f32 = 30.0;
// the upper body dies the faster the further it sits above the lower one: as long at the 909's ratio, a quarter at
// the 808's (measured on both references)
const UPPER_PIVOT: f32 = 1.42;
const UPPER_STEEPNESS: f32 = 4.4;
const SILENT: f32 = 0.0001;
const DRIVE_DC_BLOCK: f32 = 30.0;
// the asymmetry grows with Drive (full at this many dB), so a little drive stays clean and leaves no low shift
const DRIVE_BIAS_FULL: f32 = 12.0;
// the drive's ceiling in engine level (a snare hit peaks around 1.3), a power of two so Drive 0 stays bit exact
const DRIVE_CEILING: f32 = 2.0;

/// Times in seconds, Pitch in semitones above Tune, Tone in Hz, Level, Drive and Volume in dB, Punch -1 to 1, Ratio
/// as a frequency ratio, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct SnareParams {
    pub tune: f32,
    pub ratio: f32,
    pub balance: f32,
    pub pitch: f32,
    pub sweep: f32,
    pub decay: f32,
    pub punch: f32,
    pub shape: f32,
    pub level: f32,
    pub wire_decay: f32,
    pub width: f32,
    pub curve: f32,
    pub click: f32,
    pub tone: f32,
    pub skin: f32,
    pub drive: f32,
    pub volume: f32,
    pub velocity: f32,
    pub play: Play,
    pub glide: f32
}

impl Default for SnareParams {
    fn default() -> Self {
        Self {
            tune: 180.0, ratio: 1.6, balance: 0.4, pitch: 7.0, sweep: 0.01, decay: 0.2, punch: 0.0, shape: 0.0,
            level: -6.0, wire_decay: 0.25, width: 0.5, curve: 0.0, click: 0.2, tone: 4000.0, skin: 0.0,
            drive: 0.0, volume: 0.0, velocity: 0.5, play: Play::Mono, glide: 0.0
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Block {
    sweep_factor: f32,
    glide_factor: f32,
    click: ClickShape,
    wire_high: SvfCoefficients,
    wire_low: SvfCoefficients,
    wire_gain: f32,
    wire_level: f32,
    snap: SvfCoefficients,
    low: SvfCoefficients,
    dc_coefficient: f32,
    skin_radius: [f32; 4]
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
    elapsed: u32,
    bodies: [DrumOscillator; 2],
    amps: [HitEnvelope; 2],
    wire: HitEnvelope,
    tail: HitEnvelope,
    snap: HitEnvelope,
    low_burst: HitEnvelope,
    dc_input: f32,
    dc_output: f32,
    noise: WhiteNoise,
    wire_filters: [Svf; 4],
    click: Click,
    skins: [Resonator; 4]
}

impl Voice {
    fn set_envelopes(&mut self, params: &SnareParams, sample_rate: f32) {
        self.amps[0].set(0.0, 0.0, params.decay, sample_rate);
        let upper = libm::powf(UPPER_PIVOT / params.ratio.max(1.0), UPPER_STEEPNESS).min(2.0);
        self.amps[1].set(0.0, 0.0, params.decay * upper, sample_rate);
        self.amps.iter_mut().for_each(|amp| amp.set_curve(params.punch));
        let hold = params.curve.max(0.0) * WIRE_HOLD;
        self.wire.set(0.0, params.wire_decay * hold, params.wire_decay, sample_rate);
        self.tail.set(0.0, 0.0, params.wire_decay * TAIL_TIME, sample_rate);
        self.snap.set(0.0, 0.0, SNAP_TIME, sample_rate);
        self.low_burst.set(0.0, LOW_HOLD, LOW_TIME, sample_rate);
        self.wire.set_curve(params.curve.max(0.0));
        let others = [&mut self.wire, &mut self.tail, &mut self.snap, &mut self.low_burst];
        for envelope in self.amps.iter_mut().chain(others) {
            envelope.set_floor(ENVELOPE_FLOOR);
        }
    }

    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &SnareParams, held: bool,
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
        self.elapsed = 0;
        self.bodies.iter_mut().for_each(|body| body.reset(0.0));
        self.click.reset(age.wrapping_mul(0x9E37_79B9) ^ 0x5D1, restart);
        self.noise.reset(age.wrapping_mul(0x85EB_CA6B) ^ 0x5D2);
        if restart {self.wire_filters.iter_mut().for_each(|filter| filter.reset());}
        self.set_envelopes(params, sample_rate);
        for amp in self.amps.iter_mut().chain([&mut self.wire]) {
            if held {amp.trigger_held(1.0);} else {amp.trigger(1.0);}
        }
        let tail = (-params.curve).max(0.0) * TAIL_LEVEL;
        if tail <= 0.0 {self.tail.stop();} else if held {self.tail.trigger_held(tail);} else {self.tail.trigger(tail);}
        let snap = params.curve.max(0.0) * SNAP_GAIN;
        if snap <= 0.0 {self.snap.stop();} else {self.snap.trigger(snap);}
        let low_burst = params.curve.max(0.0) * LOW_BURST;
        if low_burst <= 0.0 {self.low_burst.stop();} else {self.low_burst.trigger(low_burst);}
        self.skins.iter_mut().for_each(|skin| {
            skin.reset();
            skin.strike(params.skin * SKIN_GAIN);
        });
    }

    fn release(&mut self) {
        self.gated = false;
        self.amps.iter_mut().for_each(|amp| amp.release());
        self.wire.release();
        self.tail.release();
    }

    #[inline]
    fn render(&mut self, params: &SnareParams, block: &Block, sample_rate: f32) -> f32 {
        let seconds = self.elapsed as f32 / sample_rate;
        self.elapsed = self.elapsed.saturating_add(1);
        let frequency = params.tune * libm::exp2f((self.transpose + self.slide) / 12.0) * (1.0 + self.bend);
        self.slide *= block.glide_factor;
        self.bend *= block.sweep_factor;
        let low = self.amps[0].next();
        let high = self.amps[1].next();
        let lower = self.bodies[0].sine(frequency, sample_rate);
        let upper = self.bodies[1].sine(frequency * params.ratio, sample_rate);
        let bodies = if params.shape > 0.0 {
            bend(lower, params.shape) * (1.0 - params.balance) * low + bend(upper, params.shape) * params.balance * high
        } else {
            let lead = low.max(high).max(1e-9);
            (lower * (1.0 - params.balance) * low / lead + upper * params.balance * high / lead) * lead
        };
        self.dc_output = bodies - self.dc_input + block.dc_coefficient * self.dc_output;
        self.dc_input = bodies;
        let mut value = self.dc_output;
        let rattle = self.wire.next() + self.tail.next();
        let white = self.noise.next();
        let band = self.wire_filters[0].process(white, &block.wire_high).high;
        let band = self.wire_filters[1].process(band, &block.wire_low).low * block.wire_gain;
        let snap = self.wire_filters[2].process(white, &block.snap).low * self.snap.next();
        let low = self.wire_filters[3].process(white, &block.low).low * self.low_burst.next();
        value += (band * rattle + snap + low) * block.wire_level;
        if seconds < CLICK_LENGTH {
            value += self.click.render(self.elapsed, seconds, &block.click, CLICK_NOISE_MIX) * params.click;
        }
        let mut ringing = false;
        if params.skin > 0.0 {
            for (index, skin) in self.skins.iter_mut().enumerate() {
                let coefficients = ResonatorCoefficients::with_radius(block.skin_radius[index],
                                                                      frequency * SKIN_RATIOS[index], sample_rate);
                value += skin.process(0.0, &coefficients);
                ringing |= skin.amplitude() > SILENT;
            }
        }
        let noise_idle = self.wire.is_idle() && self.tail.is_idle() && self.snap.is_idle() && self.low_burst.is_idle();
        if self.amps.iter().all(|amp| amp.is_idle()) && noise_idle && seconds >= CLICK_LENGTH && !ringing {
            self.active = false;
        }
        value * self.level
    }
}

/// Shapes a body's full level sine with Chebyshev polynomials, each adds exactly one harmonic, applied to each body
/// alone like the 909's own VCA per oscillator.
#[inline]
fn bend(value: f32, shape: f32) -> f32 {
    if shape <= 0.0 {return value;}
    let square = value * value;
    let second = 2.0 * square - 1.0;
    let third = value * (4.0 * square - 3.0);
    let fourth = 8.0 * square * (square - 1.0) + 1.0;
    value + shape * (SHAPE_HARMONICS[0] * second + SHAPE_HARMONICS[1] * third + SHAPE_HARMONICS[2] * fourth)
}

pub struct Snare {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32,
    drive: Drive,
    dry: [f32; RENDER_QUANTUM]
}

impl Snare {
    pub fn new(sample_rate: f32) -> Self {
        Self {sample_rate, voices: [Voice::default(); VOICES], hits: 0, drive: Drive::new(DRIVE_DC_BLOCK), dry: [0.0; RENDER_QUANTUM]}
    }

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &SnareParams) {
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

    pub fn note_off(&mut self, id: u32, params: &SnareParams) {
        if params.play != Play::Gate {return;}
        self.voices.iter_mut().filter(|voice| voice.active && voice.id == id).for_each(|voice| voice.release());
    }

    pub fn process(&mut self, params: &SnareParams, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let span = libm::sqrtf(WIRE_SPAN[0] * libm::powf(WIRE_SPAN[1] / WIRE_SPAN[0], params.width));
        let nyquist_guard = sample_rate * 0.45;
        let (wire_high, wire_low) = ((WIRE_CENTRE / span).min(nyquist_guard), (WIRE_CENTRE * span).min(nyquist_guard));
        let resonance = WIRE_RESONANCE[0] + (WIRE_RESONANCE[1] - WIRE_RESONANCE[0]) * params.width * params.width;
        let block = Block {
            sweep_factor: libm::expf(-1.0 / (params.sweep.max(0.0005) * sample_rate)),
            glide_factor: if params.glide > 0.0 {libm::expf(-3.0 / (params.glide * sample_rate))} else {0.0},
            click: ClickShape::new(params.tone, sample_rate),
            wire_high: SvfCoefficients::new(wire_high, WIRE_HIGH_PASS_Q, sample_rate),
            wire_low: SvfCoefficients::new(wire_low, resonance, sample_rate),
            wire_gain: WIRE_GAIN * libm::sqrtf(WIRE_REFERENCE_BAND / (wire_low - wire_high).max(100.0)),
            wire_level: if params.level <= LEVEL_OFF {0.0} else {libm::powf(10.0, params.level.min(LEVEL_MAX) / 20.0)},
            snap: SvfCoefficients::new(SNAP_CUT, 0.707, sample_rate),
            low: SvfCoefficients::new(LOW_CUT, 0.707, sample_rate),
            dc_coefficient: 1.0 - 2.0 * core::f32::consts::PI * BODY_DC_BLOCK / sample_rate,
            skin_radius: core::array::from_fn(|index| {
                ResonatorCoefficients::radius((params.decay / (3.0 + index as f32)).max(0.005), sample_rate)
            })
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

    fn render(params: &SnareParams, seconds: f32) -> Vec<f32> {
        let mut snare = Snare::new(RATE);
        snare.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        snare.process(params, &mut output);
        output
    }

    fn peak(samples: &[f32]) -> f32 {samples.iter().fold(0.0, |peak, value| peak.max(value.abs()))}

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = SnareParams {tune: 80.0, ratio: 1.0, balance: 0.0, pitch: 0.0, sweep: 0.001, decay: 0.02, punch: 0.0,
            shape: 0.0, level: LEVEL_OFF, wire_decay: 0.02, width: 0.0, curve: -1.0, click: 0.0, tone: 200.0,
            skin: 0.0, drive: 0.0, volume: -36.0, velocity: 0.0, play: Play::Mono, glide: 0.0};
        let high = SnareParams {tune: 600.0, ratio: 3.0, balance: 1.0, pitch: 24.0, sweep: 0.1, decay: 2.0, punch: -1.0,
            shape: 1.0, level: 0.0, wire_decay: 2.0, width: 1.0, curve: 1.0, click: 1.0, tone: 16000.0,
            skin: 1.0, drive: 36.0, volume: 0.0, velocity: 1.0, play: Play::Poly, glide: 1.0};
        for params in [low, high, SnareParams::default()] {
            let samples = render(&params, 2.5);
            assert!(samples.iter().all(|value| value.is_finite()));
            assert!(peak(&samples) < 4.0, "{}", peak(&samples));
        }
    }

    #[test]
    fn identical_renders() {
        let params = SnareParams {click: 0.8, skin: 0.5, drive: 6.0, curve: 0.5, ..SnareParams::default()};
        assert_eq!(render(&params, 0.5), render(&params, 0.5));
    }

    #[test]
    fn ends_silent_after_the_longest_decay() {
        let mut snare = Snare::new(RATE);
        let params = SnareParams {decay: 0.1, wire_decay: 0.2, ..SnareParams::default()};
        snare.note_on(1, 1.0, 0.0, &params);
        let mut output = vec![0.0; (0.4 * RATE) as usize];
        snare.process(&params, &mut output);
        assert!(snare.is_silent());
    }

    #[test]
    fn wires_alone_are_noise_and_bodies_alone_are_tonal() {
        let wires = render(&SnareParams {balance: 0.0, decay: 0.02, level: 0.0, click: 0.0, ..SnareParams::default()}, 0.3);
        let crossings = |samples: &[f32]| samples.windows(2).filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0).count();
        let body = render(&SnareParams {level: LEVEL_OFF, click: 0.0, pitch: 0.0, ..SnareParams::default()}, 0.1);
        assert!(crossings(&wires[..4800]) > 100, "noisy wires cross often");
        assert!((crossings(&body[..4800]) as i32 - 18).abs() <= 2, "a 180 Hz body crosses about 18 times in 0.1 s");
    }

    fn wires_alone(curve: f32) -> Vec<f32> {
        let params = SnareParams {level: 0.0, balance: 0.0, decay: 0.02, wire_decay: 0.4, click: 0.0, curve, ..SnareParams::default()};
        let mut wet = render(&params, 0.6);
        let body = render(&SnareParams {level: LEVEL_OFF, ..params}, 0.6);
        wet.iter_mut().zip(body.iter()).for_each(|(value, dry)| *value -= dry);
        wet
    }

    fn rms(samples: &[f32]) -> f32 {libm::sqrtf(samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32)}

    #[test]
    fn positive_curve_holds_the_wires_then_cuts_them() {
        let (held, plain) = (wires_alone(1.0), wires_alone(0.0));
        let window = |samples: &[f32], ms: f32| rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 10.0) * RATE / 1000.0) as usize]);
        assert!(window(&held, 60.0) > window(&held, 20.0) * 0.8, "still near the top after 60 ms (20 ms is past the snap)");
        assert!(window(&plain, 60.0) < window(&plain, 0.0) * 0.5, "an exponential has fallen by then");
        assert!(window(&held, 300.0) > window(&plain, 300.0), "a straight fall stays louder than an exponential");
        assert!(window(&held, 560.0) < window(&held, 0.0) * 0.001, "and stops after hold plus decay (0.5 s)");
    }

    #[test]
    fn negative_curve_leaves_a_long_tail() {
        let (tail, plain) = (wires_alone(-1.0), wires_alone(0.0));
        let window = |samples: &[f32], ms: f32| rms(&samples[(ms * RATE / 1000.0) as usize..((ms + 10.0) * RATE / 1000.0) as usize]);
        assert!((window(&tail, 0.0) / window(&plain, 0.0) - 1.0).abs() < 0.1, "the start is the same");
        assert!(window(&tail, 400.0) > window(&plain, 400.0) * 10.0, "a quiet second stage lingers on");
    }

    #[test]
    fn balance_moves_energy_to_the_second_body() {
        let params = SnareParams {level: LEVEL_OFF, click: 0.0, pitch: 0.0, tune: 200.0, ratio: 2.0, ..SnareParams::default()};
        let crossings = |samples: &[f32]| samples.windows(2).filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0).count();
        assert!(crossings(&render(&SnareParams {balance: 0.0, ..params}, 0.05)) < 12);
        assert!(crossings(&render(&SnareParams {balance: 1.0, ..params}, 0.05)) > 18);
    }
}
