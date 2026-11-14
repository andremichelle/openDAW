//! openDrum Kick: Drive is asymmetric like a diode, so it adds the even harmonics both machines measure (the octave
//! at about -21 dB). A body that falls from Pitch to Tune over Sweep (linear in Hz, like a swept oscillator) and from
//! Drift over ten times Sweep (in semitones), a click, membrane overtones (Skin), drive and
//! a rumble tail that every hit ducks. The parameter set is frozen (plans/drum-engines.md), fitting only moves
//! values inside it.

use dsp::drum_oscillator::DrumOscillator;
use dsp::hit_envelope::HitEnvelope;
use dsp::resonator::{Resonator, ResonatorCoefficients};
use dsp::svf::{Svf, SvfCoefficients};
use dsp::RENDER_QUANTUM;
use crate::common::{Click, ClickShape, Drive, CLICK_LENGTH, DRIVE_BIAS};

pub const VOICES: usize = 16;
pub const RUMBLE_LENGTHS: [f32; 5] = [0.0625, 0.125, 0.25, 0.5, 1.0];

const SKIN_RATIOS: [f32; 4] = [1.59, 2.14, 2.30, 2.65];
const SKIN_GAIN: f32 = 0.35;
const DRIFT_TIME: f32 = 10.0;
const RUMBLE_COMBS: [f32; 4] = [1557.0, 1617.0, 1491.0, 1422.0];
const RUMBLE_ALLPASSES: [f32; 2] = [556.0, 441.0];
const RUMBLE_FEEDBACK: f32 = 0.86;
const RUMBLE_DAMP: f32 = 0.3;
const RUMBLE_GAIN: f32 = 3.0;
const DUCK_ATTACK: f32 = 0.001;
const DUCK_RELEASE: f32 = 0.05;
const BRIGHT_RANGE: f32 = 20.0;
// a darker or lower rumble sounds quieter, so its level rises with the bandwidth it loses below the reference
const RUMBLE_REFERENCE_CUTOFF: f32 = 1500.0;
const RUMBLE_COMPENSATION: f32 = 0.35;
// long enough for the tunings at 192 kHz
const RUMBLE_COMB_LINE: usize = 7100;
const RUMBLE_ALLPASS_LINE: usize = 2450;
const RUMBLE_TONE: f32 = 1.5;
const SILENT: f32 = 0.0001;
const DRIVE_DC_BLOCK: f32 = 5.0;
const DUCK_THRESHOLD: f32 = 0.1;
// kick and rumble together stay below this peak (Duck 100 % never reaches it)
const RUMBLE_CEILING: f32 = 2.0;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub enum Play {
    #[default]
    Mono,
    Poly,
    Gate
}

/// Times in seconds, Pitch and Drift in semitones above Tune, Tone in Hz, Drive in dB, Length in bars, Punch -1
/// to 1, the rest 0 to 1.
#[derive(Clone, Copy, Debug)]
pub struct KickParams {
    pub tune: f32,
    pub pitch: f32,
    pub sweep: f32,
    pub drift: f32,
    pub decay: f32,
    pub punch: f32,
    pub shape: f32,
    pub click: f32,
    pub tone: f32,
    pub skin: f32,
    pub rumble: f32,
    pub length: f32,
    pub duck: f32,
    pub drive: f32,
    pub velocity: f32,
    pub play: Play,
    pub bright: f32,
    pub volume: f32,
    pub noise: f32,
    pub glide: f32
}

impl Default for KickParams {
    fn default() -> Self {
        Self {
            tune: 50.0, pitch: 16.0, sweep: 0.008, drift: 0.0, decay: 0.6, punch: 0.0, shape: 0.0, click: 0.3, tone: 3000.0,
            skin: 0.0, rumble: 0.0, length: 0.25, duck: 1.0, drive: 0.0, velocity: 0.5, play: Play::Mono,
            bright: 0.25, volume: 0.0, noise: 0.5, glide: 0.0
        }
    }
}

/// Values computed once per block from the parameters.
#[derive(Clone, Copy, Default)]
struct Block {
    sweep_factor: f32,
    drift_factor: f32,
    glide_factor: f32,
    click: ClickShape,
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
    drift: f32,
    elapsed: u32,
    oscillator: DrumOscillator,
    amp: HitEnvelope,
    click: Click,
    skins: [Resonator; 4]
}

impl Voice {
    fn start(&mut self, id: u32, age: u32, strength: f32, transpose: f32, params: &KickParams, held: bool,
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
        self.drift = params.drift * (0.5 + 0.5 * strength);
        self.elapsed = 0;
        self.oscillator.reset(0.0);
        self.click.reset(age.wrapping_mul(0x9E37_79B9) ^ 0x0D1, restart);
        self.amp.set(0.0, 0.0, params.decay, sample_rate);
        self.amp.set_curve(params.punch);
        if held {self.amp.trigger_held(1.0);} else {self.amp.trigger(1.0);}
        self.skins.iter_mut().for_each(|skin| {
            skin.reset();
            skin.strike(params.skin * SKIN_GAIN);
        });
    }

    #[inline]
    fn render(&mut self, params: &KickParams, block: &Block, sample_rate: f32) -> f32 {
        let seconds = self.elapsed as f32 / sample_rate;
        self.elapsed = self.elapsed.saturating_add(1);
        let frequency = params.tune * libm::exp2f((self.transpose + self.slide + self.drift) / 12.0) * (1.0 + self.bend);
        self.slide *= block.glide_factor;
        self.bend *= block.sweep_factor;
        self.drift *= block.drift_factor;
        let amp = self.amp.next();
        let mut value = self.oscillator.shaped(frequency, sample_rate, params.shape) * amp;
        if seconds < CLICK_LENGTH {
            value += self.click.render(self.elapsed, seconds, &block.click, params.noise) * params.click * self.level;
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
        if self.amp.is_idle() && seconds >= CLICK_LENGTH && !ringing {self.active = false;}
        value * self.level
    }
}

/// A dense diffuse tail (four damped feedback combs at the classic Freeverb tunings, then two allpass diffusers),
/// mono and small. Two plain echo lines would flutter at their period and sound grainy.
struct Rumble {
    combs: [[f32; RUMBLE_COMB_LINE]; 4],
    comb_lengths: [usize; 4],
    comb_damped: [f32; 4],
    allpasses: [[f32; RUMBLE_ALLPASS_LINE]; 2],
    allpass_lengths: [usize; 2],
    position: usize,
    filters: [Svf; 2],
    since_hit: u32,
    started: bool,
    sounding: bool,
    follower: f32,
    rumble_follower: f32,
    kick_follower: f32
}

impl Rumble {
    fn new(sample_rate: f32) -> Self {
        let length = |taps: f32, limit: usize| ((taps * sample_rate / 44_100.0) as usize).clamp(1, limit);
        Self {
            combs: [[0.0; RUMBLE_COMB_LINE]; 4],
            comb_lengths: RUMBLE_COMBS.map(|taps| length(taps, RUMBLE_COMB_LINE)),
            comb_damped: [0.0; 4],
            allpasses: [[0.0; RUMBLE_ALLPASS_LINE]; 2],
            allpass_lengths: RUMBLE_ALLPASSES.map(|taps| length(taps, RUMBLE_ALLPASS_LINE)),
            position: 0,
            filters: [Svf::default(); 2],
            since_hit: 0,
            started: false,
            sounding: false,
            follower: 0.0,
            rumble_follower: 0.0,
            kick_follower: 0.0
        }
    }

    #[inline]
    fn diffuse(&mut self, input: f32) -> f32 {
        let mut sum = 0.0;
        for index in 0..4 {
            let position = self.position % self.comb_lengths[index];
            let out = self.combs[index][position];
            self.comb_damped[index] = out + (self.comb_damped[index] - out) * RUMBLE_DAMP;
            self.combs[index][position] = input + self.comb_damped[index] * RUMBLE_FEEDBACK;
            sum += out;
        }
        let mut value = sum * 0.25;
        for index in 0..2 {
            let position = self.position % self.allpass_lengths[index];
            let delayed = self.allpasses[index][position];
            self.allpasses[index][position] = value + delayed * 0.5;
            value = delayed - value * 0.5;
        }
        self.position = self.position.wrapping_add(1);
        value
    }

    fn hit(&mut self) {
        self.since_hit = 0;
        self.started = true;
    }

    /// The kick feeds the diffuse tail, saturated and low passed twice. The kick's own level (smoothed over its
    /// power, so the gain never wobbles with the waveform) pushes the result down while it is loud, `duck` is how
    /// strongly, so kick and rumble sound glued.
    /// Length (in seconds here) is when the rumble has faded out.
    #[inline]
    fn render(&mut self, input: f32, driven: f32, level: f32, duck: f32, follow: (f32, f32), length: f32,
              filter: &SvfCoefficients, sample_rate: f32) -> f32 {
        self.kick_follower = driven.abs().max(self.kick_follower * (1.0 - follow.1));
        let power = input * input;
        self.follower += (power - self.follower) * if power > self.follower {follow.0} else {follow.1};
        if !self.started || level <= 0.0 {
            self.sounding = false;
            return 0.0;
        }
        let tail = self.diffuse(input);
        let seconds = self.since_hit as f32 / sample_rate;
        self.since_hit = self.since_hit.saturating_add(1);
        self.sounding = seconds < length;
        let low = self.filters[0].process(libm::tanhf(tail * 3.0), filter).low;
        let low = self.filters[1].process(low, filter).low;
        let over = libm::sqrtf(self.follower * 2.0) / DUCK_THRESHOLD;
        let ducked = 1.0 - duck * (1.0 - 1.0 / (1.0 + over * over));
        let fade = (1.0 - seconds / length.max(0.001)).max(0.0);
        let rumble = low * RUMBLE_GAIN * level * ducked * fade;
        self.rumble_follower = rumble.abs().max(self.rumble_follower * (1.0 - follow.1));
        let room = (RUMBLE_CEILING - self.kick_follower).max(0.0);
        if self.rumble_follower > room {rumble * room / self.rumble_follower} else {rumble}
    }
}

pub struct Kick {
    sample_rate: f32,
    voices: [Voice; VOICES],
    hits: u32,
    rumble: Rumble,
    drive: Drive,
    dry: [f32; RENDER_QUANTUM]
}

impl Kick {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            voices: [Voice::default(); VOICES],
            hits: 0,
            rumble: Rumble::new(sample_rate),
            drive: Drive::new(DRIVE_DC_BLOCK),
            dry: [0.0; RENDER_QUANTUM]
        }
    }

    /// `velocity` 0 to 1, `transpose` in semitones (key minus 60 on a track, 0 on a Playfield pad).
    pub fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &KickParams) {
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
        self.rumble.hit();
    }

    pub fn note_off(&mut self, id: u32, params: &KickParams) {
        if params.play != Play::Gate {return;}
        self.voices.iter_mut().filter(|voice| voice.active && voice.id == id).for_each(|voice| {
            voice.gated = false;
            voice.amp.release();
        });
    }

    /// Renders mono into `output`. `bpm` sets the rumble length.
    pub fn process(&mut self, params: &KickParams, bpm: f32, output: &mut [f32]) {
        let sample_rate = self.sample_rate;
        let block = Block {
            sweep_factor: libm::expf(-1.0 / (params.sweep.max(0.0005) * sample_rate)),
            drift_factor: libm::expf(-1.0 / (params.sweep.max(0.0005) * DRIFT_TIME * sample_rate)),
            glide_factor: if params.glide > 0.0 {libm::expf(-3.0 / (params.glide * sample_rate))} else {0.0},
            click: ClickShape::new(params.tone, sample_rate),
            skin_radius: core::array::from_fn(|index| {
                ResonatorCoefficients::radius((params.decay / (3.0 + index as f32)).max(0.005), sample_rate)
            })
        };
        let rumble_cutoff = params.tune * RUMBLE_TONE * libm::powf(BRIGHT_RANGE, params.bright);
        let rumble_filter = SvfCoefficients::new(rumble_cutoff, 0.707, sample_rate);
        let rumble_level = params.rumble * libm::powf(RUMBLE_REFERENCE_CUTOFF / rumble_cutoff.max(20.0), RUMBLE_COMPENSATION);
        let rumble_length = params.length * 240.0 / bpm.max(1.0);
        let follow = (1.0 - libm::expf(-1.0 / (DUCK_ATTACK * sample_rate)), 1.0 - libm::expf(-1.0 / (DUCK_RELEASE * sample_rate)));
        let volume = libm::powf(10.0, params.volume / 20.0);
        for voice in self.voices.iter_mut().filter(|voice| voice.active) {
            voice.amp.set(0.0, 0.0, params.decay, sample_rate);
            voice.amp.set_curve(params.punch);
        }
        for chunk in output.chunks_mut(RENDER_QUANTUM) {
            let frames = chunk.len();
            for frame in 0..frames {
                self.dry[frame] = self.voices.iter_mut().filter(|voice| voice.active)
                    .map(|voice| voice.render(params, &block, sample_rate)).sum();
            }
            self.drive.process(params.drive, DRIVE_BIAS, sample_rate, &self.dry, chunk);
            for frame in 0..frames {
                let rumble = self.rumble.render(self.dry[frame], chunk[frame], rumble_level, params.duck, follow,
                                                rumble_length, &rumble_filter, sample_rate);
                chunk[frame] = (chunk[frame] + rumble) * volume;
            }
        }
    }

    pub fn is_silent(&self) -> bool {!self.rumble.sounding && self.voices.iter().all(|voice| !voice.active)}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn render(params: &KickParams, seconds: f32) -> Vec<f32> {
        let mut kick = Kick::new(RATE);
        kick.note_on(1, 1.0, 0.0, params);
        let mut output = vec![0.0; (seconds * RATE) as usize];
        kick.process(params, 120.0, &mut output);
        output
    }

    fn peak(samples: &[f32]) -> f32 {samples.iter().fold(0.0, |peak, value| peak.max(value.abs()))}

    #[test]
    fn every_parameter_extreme_stays_finite_and_bounded() {
        let low = KickParams {tune: 30.0, pitch: 0.0, sweep: 0.001, drift: 0.0, decay: 0.02, punch: 0.0, shape: 0.0, click: 0.0,
            tone: 200.0, skin: 0.0, rumble: 0.0, length: 0.0625, duck: 0.0, drive: 0.0, velocity: 0.0, play: Play::Mono,
            bright: 0.0, volume: -36.0, noise: 0.0, glide: 0.0};
        let high = KickParams {tune: 120.0, pitch: 48.0, sweep: 0.2, drift: 12.0, decay: 6.0, punch: -1.0, shape: 1.0, click: 1.0,
            tone: 16000.0, skin: 1.0, rumble: 1.0, length: 1.0, duck: 1.0, drive: 36.0, velocity: 1.0, play: Play::Poly,
            bright: 1.0, volume: 0.0, noise: 1.0, glide: 1.0};
        for params in [low, high, KickParams::default()] {
            let samples = render(&params, 2.0);
            assert!(samples.iter().all(|value| value.is_finite()));
            assert!(peak(&samples) < 4.0, "{}", peak(&samples));
        }
    }

    #[test]
    fn identical_renders() {
        let params = KickParams {click: 0.8, skin: 0.5, rumble: 0.5, drive: 6.0, ..KickParams::default()};
        assert_eq!(render(&params, 0.5), render(&params, 0.5));
    }

    #[test]
    fn ends_silent_after_the_decay() {
        let mut kick = Kick::new(RATE);
        let params = KickParams {decay: 0.1, ..KickParams::default()};
        kick.note_on(1, 1.0, 0.0, &params);
        let mut output = vec![0.0; (0.3 * RATE) as usize];
        kick.process(&params, 120.0, &mut output);
        assert!(kick.is_silent());
    }

    #[test]
    fn gate_holds_until_note_off() {
        let mut kick = Kick::new(RATE);
        let params = KickParams {decay: 0.05, play: Play::Gate, ..KickParams::default()};
        kick.note_on(7, 1.0, 0.0, &params);
        let mut output = vec![0.0; RATE as usize];
        kick.process(&params, 120.0, &mut output);
        assert!(peak(&output[output.len() - 4800..]) > 0.5, "still sounding after 1 s");
        kick.note_off(7, &params);
        kick.process(&params, 120.0, &mut output);
        assert!(kick.is_silent());
    }

    #[test]
    fn velocity_softens_when_velocity_amount_is_up() {
        let params = KickParams {velocity: 1.0, ..KickParams::default()};
        let mut kick = Kick::new(RATE);
        kick.note_on(1, 0.25, 0.0, &params);
        let mut soft = vec![0.0; 9600];
        kick.process(&params, 120.0, &mut soft);
        assert!(peak(&soft) < peak(&render(&params, 0.2)) * 0.5);
    }

    #[test]
    fn rumble_is_ducked_right_after_the_attack() {
        let params = KickParams {rumble: 1.0, duck: 1.0, click: 0.0, ..KickParams::default()};
        let mut with = render(&params, 1.0);
        let without = render(&KickParams {rumble: 0.0, ..params}, 1.0);
        with.iter_mut().zip(without.iter()).for_each(|(value, dry)| *value -= dry);
        let early = peak(&with[..(0.01 * RATE) as usize]);
        let later = peak(&with[(0.2 * RATE) as usize..(0.4 * RATE) as usize]);
        assert!(early < later * 0.2, "rumble at the attack {early}, later {later}");
    }

    #[test]
    fn the_rumble_tail_keeps_the_kick_sounding() {
        let params = KickParams {rumble: 1.0, length: 1.0, decay: 0.3, ..KickParams::default()};
        let mut kick = Kick::new(RATE);
        kick.note_on(1, 1.0, 0.0, &params);
        let mut output = vec![0.0; (1.0 * RATE) as usize];
        kick.process(&params, 120.0, &mut output);
        assert!(!kick.is_silent(), "the body has ended, the 2 s rumble has not");
        let mut rest = vec![0.0; (1.2 * RATE) as usize];
        kick.process(&params, 120.0, &mut rest);
        assert!(kick.is_silent(), "silent once the rumble has faded");
    }

    #[test]
    fn the_rumble_keeps_four_distinct_combs_at_high_rates() {
        for rate in [44_100.0, 96_000.0, 192_000.0] {
            let rumble = Rumble::new(rate);
            let mut lengths = rumble.comb_lengths.to_vec();
            lengths.dedup();
            assert_eq!(lengths.len(), 4, "{rate} Hz");
            assert_ne!(rumble.allpass_lengths[0], rumble.allpass_lengths[1], "{rate} Hz");
            assert!(rumble.comb_lengths.iter().all(|length| *length < RUMBLE_COMB_LINE), "{rate} Hz");
            assert!(rumble.allpass_lengths.iter().all(|length| *length < RUMBLE_ALLPASS_LINE), "{rate} Hz");
        }
    }

    #[test]
    fn rumble_waits_for_a_loud_body_and_follows_a_short_one() {
        let rumble_at = |decay: f32| {
            let params = KickParams {rumble: 1.0, duck: 1.0, click: 0.0, decay, ..KickParams::default()};
            let mut with = render(&params, 0.5);
            let without = render(&KickParams {rumble: 0.0, ..params}, 0.5);
            with.iter_mut().zip(without.iter()).for_each(|(value, dry)| *value -= dry);
            peak(&with[(0.1 * RATE) as usize..(0.15 * RATE) as usize])
        };
        assert!(rumble_at(1.0) < rumble_at(0.08) * 0.5, "long body {}, short body {}", rumble_at(1.0), rumble_at(0.08));
    }

    fn rising_crossings(samples: &[f32]) -> usize {samples.windows(2).filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0).count()}

    #[test]
    fn less_duck_never_pushes_kick_and_rumble_past_the_ceiling() {
        for duck in [0.0, 0.25, 0.5, 0.75] {
            for drive in [0.0, 12.0, 36.0] {
                let params = KickParams {rumble: 1.0, length: 1.0, duck, drive, ..KickParams::default()};
                let peak = render(&params, 2.0).iter().fold(0.0f32, |peak, value| peak.max(value.abs()));
                assert!(peak <= RUMBLE_CEILING + 0.01, "duck {duck} drive {drive}: {peak}");
            }
        }
    }

    #[test]
    fn glide_slides_to_the_new_note() {
        let crossings = |glide: f32| {
            let params = KickParams {tune: 100.0, pitch: 0.0, drift: 0.0, click: 0.0, decay: 2.0, glide, ..KickParams::default()};
            let mut kick = Kick::new(RATE);
            kick.note_on(1, 1.0, 0.0, &params);
            let mut output = vec![0.0; (0.1 * RATE) as usize];
            kick.process(&params, 120.0, &mut output);
            kick.note_on(2, 1.0, 12.0, &params);
            let mut after = vec![0.0; (0.05 * RATE) as usize];
            kick.process(&params, 120.0, &mut after);
            rising_crossings(&after)
        };
        assert_eq!(crossings(0.0), 9, "jumps to 200 Hz (the reset start crossing is not counted)");
        assert!(crossings(0.3) < 8, "still below 200 Hz while sliding, {}", crossings(0.3));
    }

    #[test]
    fn gate_plays_legato_while_held() {
        let params = KickParams {decay: 0.2, play: Play::Gate, glide: 0.05, ..KickParams::default()};
        let mut kick = Kick::new(RATE);
        kick.note_on(1, 1.0, 0.0, &params);
        let mut output = vec![0.0; (0.5 * RATE) as usize];
        kick.process(&params, 120.0, &mut output);
        kick.note_on(2, 1.0, 5.0, &params);
        assert_eq!(kick.voices[0].elapsed as usize, output.len(), "no retrigger while the gate is held");
        kick.note_off(1, &params);
        kick.process(&params, 120.0, &mut output);
        assert!(!kick.is_silent(), "the old id no longer owns the voice");
        kick.note_off(2, &params);
        kick.process(&params, 120.0, &mut output);
        assert!(kick.is_silent());
    }

    #[test]
    fn volume_scales_the_output() {
        let quiet = render(&KickParams {volume: -6.0, ..KickParams::default()}, 0.2);
        let full = render(&KickParams::default(), 0.2);
        assert!((peak(&quiet) / peak(&full) - 0.501).abs() < 0.01);
    }

    #[test]
    fn poly_overlaps_and_mono_retriggers() {
        let params = KickParams {decay: 1.0, play: Play::Poly, ..KickParams::default()};
        let mut kick = Kick::new(RATE);
        kick.note_on(1, 1.0, 0.0, &params);
        kick.note_on(2, 1.0, 0.0, &params);
        assert_eq!(kick.voices.iter().filter(|voice| voice.active).count(), 2);
        let mono = KickParams {play: Play::Mono, ..params};
        let mut kick = Kick::new(RATE);
        kick.note_on(1, 1.0, 0.0, &mono);
        kick.note_on(2, 1.0, 0.0, &mono);
        assert_eq!(kick.voices.iter().filter(|voice| voice.active).count(), 1);
    }
}
