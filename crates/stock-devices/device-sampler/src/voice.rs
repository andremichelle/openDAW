//! One sounding sample zone: a read head with cubic interpolation and a crossfaded loop, two envelopes, two
//! LFOs and a filter. A voice copies what it needs from its zone when it starts, so it keeps sounding as it
//! was triggered while the zone table changes underneath.

use core::f32::consts::PI;
use crate::zones::{Zone, LOOP_OFF, LOOP_ON};

const SILENCE: f32 = 1.0e-4;
const MIN_LOOP_FRAMES: f64 = 4.0;

/// Envelope times in frames, decay and release as the per-frame factor that reaches -60 dB in their time.
#[derive(Clone, Copy)]
pub struct EnvelopeParams {
    pub delay: u32,
    pub attack: u32,
    pub hold: u32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32
}

/// The per-frame factor of an exponential fall that reaches -60 dB after `seconds`.
pub fn fall_factor(seconds: f32, sample_rate: f32) -> f32 {
    libm::expf(-6.907_755 / (seconds * sample_rate).max(1.0))
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {Idle, Delay, Attack, Hold, Decay, Sustain, Release}

#[derive(Clone, Copy)]
pub struct Envelope {
    stage: Stage,
    level: f32,
    counter: u32
}

impl Envelope {
    pub fn start(&mut self) {
        self.stage = Stage::Delay;
        self.level = 0.0;
        self.counter = 0;
    }

    pub fn release(&mut self) {
        if self.stage != Stage::Idle {self.stage = Stage::Release;}
    }

    pub fn level(&self) -> f32 {self.level}
    pub fn is_idle(&self) -> bool {self.stage == Stage::Idle}

    // a sustain of nothing is the end of the sound for the amp envelope
    pub fn is_silent_sustain(&self) -> bool {self.stage == Stage::Sustain && self.level <= SILENCE}

    /// Advance one frame. `release` overrides the release of `params` (a choke or a stolen voice falls fast).
    pub fn tick(&mut self, params: &EnvelopeParams, release: f32) -> f32 {
        loop {
            match self.stage {
                Stage::Idle => return 0.0,
                Stage::Delay => {
                    if self.counter < params.delay {
                        self.counter += 1;
                        return 0.0;
                    }
                    self.stage = Stage::Attack;
                    self.counter = 0;
                }
                Stage::Attack => {
                    if self.counter < params.attack {
                        self.counter += 1;
                        self.level = self.counter as f32 / params.attack as f32;
                        return self.level;
                    }
                    self.level = 1.0;
                    self.stage = Stage::Hold;
                    self.counter = 0;
                }
                Stage::Hold => {
                    if self.counter < params.hold {
                        self.counter += 1;
                        return 1.0;
                    }
                    self.stage = Stage::Decay;
                }
                Stage::Decay => {
                    self.level = params.sustain + (self.level - params.sustain) * params.decay;
                    if libm::fabsf(self.level - params.sustain) < SILENCE {
                        self.level = params.sustain;
                        self.stage = Stage::Sustain;
                    }
                    return self.level;
                }
                Stage::Sustain => {
                    self.level = params.sustain;
                    return self.level;
                }
                Stage::Release => {
                    self.level *= release;
                    if self.level < SILENCE {
                        self.level = 0.0;
                        self.stage = Stage::Idle;
                    }
                    return self.level;
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
pub struct LfoParams {
    pub shape: i32,
    pub hertz: f32,
    pub delay: f32, // frames
    pub fade: f32   // frames
}

#[derive(Clone, Copy)]
pub struct Lfo {
    pub phase: f32,
    elapsed: f32
}

impl Lfo {
    pub fn start(&mut self, phase: f32) {
        self.phase = phase;
        self.elapsed = 0.0;
    }

    /// The value in -1 to 1 at the current phase, silent through the delay and rising over the fade.
    pub fn value(&self, params: &LfoParams) -> f32 {
        let depth = if self.elapsed < params.delay {
            0.0
        } else if params.fade <= 0.0 {
            1.0
        } else {
            ((self.elapsed - params.delay) / params.fade).min(1.0)
        };
        shape_value(params.shape, self.phase) * depth
    }

    pub fn advance(&mut self, hertz: f32, frames: f32, sample_rate: f32) {
        self.phase += hertz * frames / sample_rate;
        self.phase -= libm::floorf(self.phase);
        self.elapsed += frames;
    }
}

/// Sine, triangle, rising saw and square over one cycle of `phase`.
pub fn shape_value(shape: i32, phase: f32) -> f32 {
    match shape {
        1 => 1.0 - 4.0 * libm::fabsf(libm::floorf(phase + 0.25) + 0.25 - phase),
        2 => 2.0 * phase - 1.0,
        3 => if phase < 0.5 {1.0} else {-1.0},
        _ => libm::sinf(phase * 2.0 * PI)
    }
}

/// A two-pole state variable filter (topology preserving), one per stage and channel.
#[derive(Clone, Copy)]
pub struct Svf {
    ic1: f32,
    ic2: f32
}

#[derive(Clone, Copy)]
pub struct SvfCoefficients {
    a1: f32,
    a2: f32,
    a3: f32,
    k: f32
}

impl SvfCoefficients {
    pub fn new(hertz: f32, q: f32, sample_rate: f32) -> Self {
        let g = libm::tanf(PI * (hertz / sample_rate).min(0.49));
        let k = 1.0 / q;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        Self {a1, a2, a3: g * a2, k}
    }
}

impl Svf {
    pub fn clear(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    /// The low-pass and high-pass outputs for one input frame.
    #[inline]
    pub fn tick(&mut self, input: f32, coefficients: &SvfCoefficients) -> (f32, f32) {
        let v3 = input - self.ic2;
        let v1 = coefficients.a1 * self.ic1 + coefficients.a2 * v3;
        let v2 = self.ic2 + coefficients.a2 * self.ic1 + coefficients.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, input - coefficients.k * v1 - v2)
    }
}

pub const FILTER_OFF: i32 = 0;
pub const FILTER_LOW_PASS_24: i32 = 2;
pub const FILTER_HIGH_PASS_12: i32 = 3;

/// What the device hands a voice for one control interval: where its read head, filter and gains are going.
#[derive(Clone, Copy)]
pub struct Control {
    pub increment: f64, // source frames per output frame, always positive
    pub filter_type: i32,
    pub filter: SvfCoefficients,
    pub filter_second: SvfCoefficients,
    pub gain_left: f32,
    pub gain_right: f32,
    pub mono: f32
}

#[derive(Clone, Copy)]
pub struct Voice {
    active: bool,
    pub id: u32,
    pub seq: u64,
    pub key: i32,
    pub pitch: f32,     // the played key with its cents, the glide ends here
    pub velocity: f32,
    pub random: f32,
    pub glide_from: f32,
    pub glide_frames: u32,
    pub glide_position: u32,
    pub fade_gain: f32,
    pub choke: i32,
    pub zone: Zone,
    pub sample: u32,
    pub row: u32, // the zone's row in the table when the voice started, the editor finds the zone by it
    pub start_shift: f32, // modulation of the sample start, in the zone's length
    pub loop_shift: f32,  // modulation of the loop start, in the loop's length
    prepared: bool,
    stale: bool,
    backward: bool,
    position: f64,
    start: f64,
    end: f64,
    loop_start: f64,
    loop_end: f64,
    loop_fade: f64,
    released: bool,
    key_up: bool,
    pub release_sample: bool,
    // when its key went up, in the order of the device's events
    pub ringing_since: u64,
    fast: bool,
    pub amp: Envelope,
    pub modulation: Envelope,
    pub lfos: [Lfo; 2],
    filters: [[Svf; 2]; 2],
    gain_left: f32,
    gain_right: f32,
    gains_set: bool
}

impl Voice {
    pub fn is_active(&self) -> bool {self.active}
    pub fn is_released(&self) -> bool {self.released}
    pub fn is_fading(&self) -> bool {self.fast}
    // the key is up: a tail, or a one shot that plays on by itself
    pub fn is_ringing_out(&self) -> bool {self.key_up}
    pub fn mark_release_sample(&mut self) {
        self.release_sample = true;
        self.key_up = true;
        self.zone.one_shot = true;
        self.zone.loop_mode = LOOP_OFF;
    }
    pub fn position(&self) -> f64 {self.position}

    #[allow(clippy::too_many_arguments)]
    pub fn start(&mut self, id: u32, seq: u64, key: i32, pitch: f32, velocity: f32, random: f32, zone: Zone, sample: u32,
                 fade_gain: f32, choke: i32, lfo_phases: [f32; 2]) {
        self.active = true;
        self.id = id;
        self.seq = seq;
        self.key = key;
        self.pitch = pitch;
        self.velocity = velocity;
        self.random = random;
        self.glide_from = pitch;
        self.glide_frames = 0;
        self.glide_position = 0;
        self.fade_gain = fade_gain;
        self.choke = choke;
        self.zone = zone;
        self.sample = sample;
        self.row = 0;
        self.start_shift = 0.0;
        self.loop_shift = 0.0;
        self.prepared = false;
        self.stale = false;
        self.backward = zone.reverse;
        self.released = false;
        self.key_up = false;
        self.release_sample = false;
        self.ringing_since = u64::MAX;
        self.fast = false;
        self.amp.start();
        self.modulation.start();
        self.lfos[0].start(lfo_phases[0]);
        self.lfos[1].start(lfo_phases[1]);
        for stage in self.filters.iter_mut() {
            for filter in stage.iter_mut() {
                filter.clear();
            }
        }
        self.gains_set = false;
    }

    pub fn glide(&mut self, from: f32, frames: u32) {
        self.glide_from = from;
        self.glide_frames = frames;
        self.glide_position = 0;
    }

    /// The pitch right now in keys, on its way from where the glide started to the played key.
    pub fn current_pitch(&self) -> f32 {
        if self.glide_position >= self.glide_frames {
            self.pitch
        } else {
            self.glide_from + (self.pitch - self.glide_from) * (self.glide_position as f32 / self.glide_frames as f32)
        }
    }

    pub fn note_off(&mut self) {
        self.key_up = true;
        if self.zone.one_shot {return}
        self.released = true;
        self.amp.release();
        self.modulation.release();
    }

    // a choke or a stolen voice: out within a few milliseconds whatever the zone says
    pub fn fast_release(&mut self) {
        self.key_up = true;
        self.released = true;
        self.fast = true;
        self.amp.release();
        self.modulation.release();
    }

    pub fn stop(&mut self) {self.active = false;}

    pub fn follow(&mut self, zone: Zone) {
        self.zone = zone;
        if self.release_sample {
            self.zone.one_shot = true;
            self.zone.loop_mode = LOOP_OFF;
        }
        self.stale = true;
    }

    // Resolve the zone's frames against the sample that is now resident.
    fn prepare(&mut self, frame_count: usize, sample_rate: f32) {
        self.resolve(frame_count, sample_rate);
        self.position = if self.zone.reverse {(self.end - 1.0).max(self.start)} else {self.start};
        self.prepared = true;
    }

    fn resolve(&mut self, frame_count: usize, sample_rate: f32) {
        let frames = frame_count as f64;
        let start = (self.zone.sample_start as f64).clamp(0.0, frames);
        let end = (self.zone.sample_end as f64).clamp(start, frames);
        let shifted = (start + self.start_shift as f64 * (end - start)).clamp(start, end);
        self.start = shifted;
        self.end = end;
        let loop_start = (self.zone.loop_start as f64).clamp(start, end);
        let loop_end = (self.zone.loop_end as f64).clamp(loop_start, end);
        let moved = loop_start + self.loop_shift as f64 * (loop_end - loop_start);
        self.loop_start = moved.clamp(start, loop_end);
        self.loop_end = loop_end;
        let length = self.loop_end - self.loop_start;
        let room = if self.zone.reverse {self.end - self.loop_end} else {self.loop_start - start};
        self.loop_fade = (self.zone.loop_fade as f64 * sample_rate as f64).min(length).min(room).max(0.0);
        self.stale = false;
    }

    fn loops(&self) -> bool {
        !self.zone.one_shot && self.loop_end - self.loop_start >= MIN_LOOP_FRAMES
            && (self.zone.loop_mode > LOOP_ON || (self.zone.loop_mode == LOOP_ON && !self.released))
    }

    /// Render `left.len()` frames of this voice onto the output, its gains gliding to the control's.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, planes: [&[f32]; 2], source_rate: f32, control: &Control, amp: &EnvelopeParams,
                  modulation: &EnvelopeParams, fast_release: f32, left: &mut [f32], right: &mut [f32]) {
        if !self.prepared {
            self.prepare(planes[0].len(), source_rate);
        } else if self.stale {
            self.resolve(planes[0].len(), source_rate);
        }
        if self.end - self.start < 1.0 {
            self.active = false;
            return;
        }
        if !self.gains_set {
            self.gain_left = control.gain_left;
            self.gain_right = control.gain_right;
            self.gains_set = true;
        }
        let frames = left.len();
        let step_left = (control.gain_left - self.gain_left) / frames as f32;
        let step_right = (control.gain_right - self.gain_right) / frames as f32;
        let release = if self.fast {fast_release} else {amp.release};
        for index in 0..frames {
            let level = self.amp.tick(amp, release);
            self.modulation.tick(modulation, modulation.release);
            if self.amp.is_idle() || self.amp.is_silent_sustain() {
                self.active = false;
                return;
            }
            let looping = self.loops();
            let alternate = looping && self.zone.loop_alternate;
            if !alternate {self.backward = self.zone.reverse;}
            let reverse = self.backward;
            let (mut sample_left, mut sample_right) = read_stereo(planes, self.position);
            if looping && !alternate && self.loop_fade > 0.0 {
                let length = self.loop_end - self.loop_start;
                let into = if reverse {self.loop_start + self.loop_fade - self.position} else {self.position - (self.loop_end - self.loop_fade)};
                if into > 0.0 {
                    let mix = (into / self.loop_fade).min(1.0) as f32;
                    let other = if reverse {self.position + length} else {self.position - length};
                    let (other_left, other_right) = read_stereo(planes, other);
                    sample_left += (other_left - sample_left) * mix;
                    sample_right += (other_right - sample_right) * mix;
                }
            }
            if control.mono > 0.0 {
                let mid = (sample_left + sample_right) * 0.5;
                sample_left += (mid - sample_left) * control.mono;
                sample_right += (mid - sample_right) * control.mono;
            }
            if control.filter_type != FILTER_OFF {
                let high_pass = control.filter_type == FILTER_HIGH_PASS_12;
                let (low, high) = self.filters[0][0].tick(sample_left, &control.filter);
                sample_left = if high_pass {high} else {low};
                let (low, high) = self.filters[0][1].tick(sample_right, &control.filter);
                sample_right = if high_pass {high} else {low};
                if control.filter_type == FILTER_LOW_PASS_24 {
                    sample_left = self.filters[1][0].tick(sample_left, &control.filter_second).0;
                    sample_right = self.filters[1][1].tick(sample_right, &control.filter_second).0;
                }
            }
            self.gain_left += step_left;
            self.gain_right += step_right;
            left[index] += sample_left * level * self.gain_left;
            right[index] += sample_right * level * self.gain_right;
            if self.glide_position < self.glide_frames {self.glide_position += 1;}
            if reverse {
                self.position -= control.increment;
                if alternate && self.position < self.loop_start {
                    self.position = (2.0 * self.loop_start - self.position).min(self.loop_end - 1.0);
                    self.backward = false;
                } else if looping && self.position < self.loop_start {
                    self.position = self.loop_end - (self.loop_start - self.position) % (self.loop_end - self.loop_start);
                } else if self.position < self.start {
                    self.active = false;
                    return;
                }
            } else {
                self.position += control.increment;
                if alternate && self.position >= self.loop_end {
                    self.position = (2.0 * (self.loop_end - 1.0) - self.position).max(self.loop_start);
                    self.backward = true;
                } else if looping && self.position >= self.loop_end {
                    self.position = self.loop_start + (self.position - self.loop_start) % (self.loop_end - self.loop_start);
                } else if self.position >= self.end {
                    self.active = false;
                    return;
                }
            }
        }
    }
}

#[inline]
fn read_stereo(planes: [&[f32]; 2], position: f64) -> (f32, f32) {
    (read(planes[0], position), read(planes[1], position))
}

/// Cubic (Hermite) interpolation at a fractional frame, the frames beyond either end repeat the last one.
#[inline]
pub fn read(plane: &[f32], position: f64) -> f32 {
    let last = plane.len() as isize - 1;
    if last < 0 {
        return 0.0;
    }
    let floor = libm::floor(position);
    let index = floor as isize;
    let fraction = (position - floor) as f32;
    let at = |offset: isize| plane[(index + offset).clamp(0, last) as usize];
    let (before, here, next, after) = (at(-1), at(0), at(1), at(2));
    let c1 = 0.5 * (next - before);
    let c2 = before - 2.5 * here + 2.0 * next - 0.5 * after;
    let c3 = 0.5 * (after - before) + 1.5 * (here - next);
    ((c3 * fraction + c2) * fraction + c1) * fraction + here
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zones::tests::zone;
    use crate::zones::LOOP_OFF;

    const SR: f32 = 48_000.0;
    const LOOP_ALWAYS: i32 = 2;

    fn params(delay: u32, attack: u32, hold: u32, decay: f32, sustain: f32, release: f32) -> EnvelopeParams {
        EnvelopeParams {delay, attack, hold, decay, sustain, release}
    }

    fn instant() -> EnvelopeParams {params(0, 1, 0, 0.5, 1.0, 0.5)}

    fn envelope() -> Envelope {
        let mut envelope: Envelope = unsafe { core::mem::zeroed() };
        envelope.start();
        envelope
    }

    fn levels(envelope: &mut Envelope, params: &EnvelopeParams, frames: usize) -> Vec<f32> {
        (0..frames).map(|_| envelope.tick(params, params.release)).collect()
    }

    #[test]
    fn a_zeroed_envelope_is_idle_and_silent() {
        let mut envelope: Envelope = unsafe { core::mem::zeroed() };
        assert!(envelope.is_idle());
        assert_eq!(envelope.tick(&instant(), 0.5), 0.0);
        envelope.release();
        assert!(envelope.is_idle(), "releasing an idle envelope starts nothing");
    }

    #[test]
    fn delay_attack_and_hold_take_their_frames() {
        let params = params(2, 4, 3, 0.5, 0.5, 0.5);
        let mut envelope = envelope();
        assert_eq!(levels(&mut envelope, &params, 9), [0.0, 0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 1.0, 1.0]);
    }

    #[test]
    fn decay_falls_to_the_sustain_and_stays() {
        let params = params(0, 1, 0, 0.5, 0.25, 0.5);
        let mut envelope = envelope();
        let rendered = levels(&mut envelope, &params, 40);
        assert_eq!(rendered[0], 1.0);
        assert_eq!(rendered[1], 0.25 + 0.75 * 0.5);
        assert!(rendered.windows(2).all(|pair| pair[1] <= pair[0]), "never rises");
        assert_eq!(rendered[39], 0.25);
    }

    #[test]
    fn the_sustain_follows_its_parameter() {
        let mut envelope = envelope();
        levels(&mut envelope, &params(0, 1, 0, 0.5, 0.5, 0.5), 60);
        assert_eq!(envelope.tick(&params(0, 1, 0, 0.5, 0.75, 0.5), 0.5), 0.75);
    }

    #[test]
    fn release_falls_to_idle() {
        let params = instant();
        let mut envelope = envelope();
        envelope.tick(&params, params.release);
        envelope.release();
        let rendered = levels(&mut envelope, &params, 20);
        assert_eq!(rendered[..3], [0.5, 0.25, 0.125]);
        assert!(envelope.is_idle());
        assert_eq!(rendered[19], 0.0);
    }

    #[test]
    fn a_release_during_the_attack_falls_from_where_it_is() {
        let params = params(0, 4, 0, 0.5, 1.0, 0.5);
        let mut envelope = envelope();
        levels(&mut envelope, &params, 2);
        envelope.release();
        assert_eq!(envelope.tick(&params, params.release), 0.25);
    }

    #[test]
    fn a_release_during_the_delay_ends_at_once() {
        let params = params(10, 4, 0, 0.5, 1.0, 0.5);
        let mut envelope = envelope();
        envelope.tick(&params, params.release);
        envelope.release();
        assert_eq!(envelope.tick(&params, params.release), 0.0);
        assert!(envelope.is_idle());
    }

    #[test]
    fn the_override_replaces_the_release() {
        let params = instant();
        let mut envelope = envelope();
        envelope.tick(&params, params.release);
        envelope.release();
        assert_eq!(envelope.tick(&params, 0.1), 0.1);
    }

    #[test]
    fn a_sustain_of_nothing_is_reported() {
        let params = params(0, 1, 0, 0.5, 0.0, 0.5);
        let mut envelope = envelope();
        levels(&mut envelope, &params, 40);
        assert!(envelope.is_silent_sustain());
        let mut held = envelope_at_sustain(0.5);
        assert!(!held.is_silent_sustain());
        held.release();
        assert!(!held.is_silent_sustain(), "a releasing envelope is not a silent sustain");
    }

    fn envelope_at_sustain(sustain: f32) -> Envelope {
        let mut envelope = envelope();
        levels(&mut envelope, &params(0, 1, 0, 0.5, sustain, 0.5), 60);
        envelope
    }

    #[test]
    fn the_fall_factor_reaches_minus_60_db_in_its_time() {
        let factor = fall_factor(0.5, SR);
        let level = libm::powf(factor, 0.5 * SR);
        assert!((level - 0.001).abs() < 1.0e-5, "{level}");
        assert!(fall_factor(0.0, SR) > 0.0 && fall_factor(0.0, SR) < 0.01, "no time falls within a frame");
    }

    #[test]
    fn the_shapes_over_one_cycle() {
        let eps = 1.0e-6;
        for (shape, expected) in [
            (0, [0.0, 1.0, 0.0, -1.0]), (1, [0.0, 1.0, 0.0, -1.0]), (2, [-1.0, -0.5, 0.0, 0.5]), (3, [1.0, 1.0, -1.0, -1.0])
        ] {
            for (step, value) in expected.iter().enumerate() {
                assert!((shape_value(shape, step as f32 * 0.25) - value).abs() < eps, "shape {shape} step {step}");
            }
        }
        assert!((shape_value(1, 0.125) - 0.5).abs() < eps, "the triangle is linear");
        assert!((shape_value(99, 0.25) - 1.0).abs() < eps, "an unknown shape is a sine");
    }

    #[test]
    fn an_lfo_waits_through_its_delay_then_fades_in() {
        let params = LfoParams {shape: 3, hertz: 1.0, delay: 100.0, fade: 200.0};
        let mut lfo: Lfo = unsafe { core::mem::zeroed() };
        lfo.start(0.0);
        assert_eq!(lfo.value(&params), 0.0);
        lfo.advance(0.0, 100.0, SR);
        assert_eq!(lfo.value(&params), 0.0, "the fade starts at nothing");
        lfo.advance(0.0, 100.0, SR);
        assert_eq!(lfo.value(&params), 0.5);
        lfo.advance(0.0, 500.0, SR);
        assert_eq!(lfo.value(&params), 1.0);
    }

    #[test]
    fn an_lfo_without_delay_or_fade_is_there_at_once() {
        let params = LfoParams {shape: 3, hertz: 1.0, delay: 0.0, fade: 0.0};
        let mut lfo: Lfo = unsafe { core::mem::zeroed() };
        lfo.start(0.75);
        assert_eq!(lfo.value(&params), -1.0, "it starts at the phase it was given");
    }

    #[test]
    fn the_phase_advances_and_wraps() {
        let mut lfo: Lfo = unsafe { core::mem::zeroed() };
        lfo.start(0.0);
        lfo.advance(1.0, SR * 0.25, SR);
        assert!((lfo.phase - 0.25).abs() < 1.0e-6);
        lfo.advance(1.0, SR * 2.0, SR);
        assert!((lfo.phase - 0.25).abs() < 1.0e-4, "two whole cycles later it is where it was");
        assert!(lfo.phase >= 0.0 && lfo.phase < 1.0);
    }

    fn settle(filter_type: i32, hertz: f32, input: &dyn Fn(usize) -> f32) -> f32 {
        let coefficients = SvfCoefficients::new(hertz, core::f32::consts::FRAC_1_SQRT_2, SR);
        let mut filter: Svf = unsafe { core::mem::zeroed() };
        let mut peak = 0.0f32;
        for frame in 0..4_800 {
            let (low, high) = filter.tick(input(frame), &coefficients);
            let output = if filter_type == FILTER_HIGH_PASS_12 {high} else {low};
            if frame >= 2_400 {peak = peak.max(output.abs());}
        }
        peak
    }

    #[test]
    fn the_low_pass_keeps_dc_and_removes_the_top() {
        assert!((settle(1, 1_000.0, &|_| 1.0) - 1.0).abs() < 1.0e-3);
        assert!(settle(1, 1_000.0, &|frame| if frame % 2 == 0 {1.0} else {-1.0}) < 1.0e-2);
    }

    #[test]
    fn the_high_pass_removes_dc_and_keeps_the_top() {
        assert!(settle(FILTER_HIGH_PASS_12, 1_000.0, &|_| 1.0) < 1.0e-3);
        assert!(settle(FILTER_HIGH_PASS_12, 1_000.0, &|frame| if frame % 2 == 0 {1.0} else {-1.0}) > 0.9);
    }

    #[test]
    fn a_cutoff_above_nyquist_stays_stable() {
        let peak = settle(1, 96_000.0, &|frame| if frame % 7 == 0 {1.0} else {-0.5});
        assert!(peak.is_finite() && peak < 4.0);
    }

    #[test]
    fn a_cleared_filter_forgets() {
        let coefficients = SvfCoefficients::new(500.0, 2.0, SR);
        let mut filter: Svf = unsafe { core::mem::zeroed() };
        (0..100).for_each(|_| {filter.tick(1.0, &coefficients);});
        filter.clear();
        assert_eq!(filter.tick(0.0, &coefficients), (0.0, 0.0));
    }

    #[test]
    fn reading_at_a_frame_returns_the_frame() {
        let plane = [0.5, -0.25, 1.0, 0.125];
        for (index, value) in plane.iter().enumerate() {
            assert_eq!(read(&plane, index as f64), *value);
        }
    }

    #[test]
    fn a_straight_line_is_read_exactly_between_frames() {
        let plane: Vec<f32> = (0..16).map(|index| index as f32 * 0.5).collect();
        assert!((read(&plane, 7.25) - 3.625).abs() < 1.0e-6);
        assert!((read(&plane, 3.75) - 1.875).abs() < 1.0e-6);
    }

    #[test]
    fn reading_beyond_either_end_holds_the_last_frame() {
        let plane = [0.5, 0.75];
        assert_eq!(read(&plane, -3.0), 0.5);
        assert_eq!(read(&plane, 40.0), 0.75);
        assert_eq!(read(&[], 0.0), 0.0, "an empty sample is silence");
        assert_eq!(read(&[0.25], 0.5), 0.25, "a one frame sample is that frame");
    }

    fn control(increment: f64) -> Control {
        let open = SvfCoefficients::new(1_000.0, 0.707, SR);
        Control {increment, filter_type: FILTER_OFF, filter: open, filter_second: open, gain_left: 1.0, gain_right: 1.0, mono: 0.0}
    }

    fn voice(zone: crate::zones::Zone) -> Voice {
        let mut voice: Voice = unsafe { core::mem::zeroed() };
        voice.start(1, 0, 60, 60.0, 1.0, 0.0, zone, 1, 1.0, 0, [0.0, 0.0]);
        voice
    }

    fn ramp(frames: usize) -> Vec<f32> {(0..frames).map(|index| index as f32).collect()}

    fn play(voice: &mut Voice, plane: &[f32], control: &Control, frames: usize) -> Vec<f32> {
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let envelope = instant();
        voice.render([plane, plane], SR, control, &envelope, &envelope, 0.01, &mut left, &mut right);
        left
    }

    #[test]
    fn a_voice_plays_its_sample_frame_by_frame_and_ends_with_it() {
        let plane = ramp(8);
        let mut voice = voice(zone());
        assert_eq!(play(&mut voice, &plane, &control(1.0), 12), [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 0.0, 0.0, 0.0, 0.0]);
        assert!(!voice.is_active());
    }

    #[test]
    fn the_increment_sets_the_speed() {
        let plane = ramp(64);
        let mut double = voice(zone());
        assert_eq!(play(&mut double, &plane, &control(2.0), 4), [0.0, 2.0, 4.0, 6.0]);
        let mut half = voice_at(8, 32);
        let slow = play(&mut half, &plane, &control(0.5), 4);
        assert!(slow.iter().zip([8.0, 8.5, 9.0, 9.5]).all(|(got, want)| (got - want).abs() < 1.0e-5), "{slow:?}");
    }

    #[test]
    fn start_and_end_frame_the_sample() {
        let plane = ramp(32);
        let mut voice = voice(crate::zones::Zone {sample_start: 4, sample_end: 7, ..zone()});
        assert_eq!(play(&mut voice, &plane, &control(1.0), 6), [4.0, 5.0, 6.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn frames_beyond_the_sample_are_clamped() {
        let plane = ramp(4);
        let mut voice = voice(crate::zones::Zone {sample_start: 2, sample_end: i32::MAX, ..zone()});
        assert_eq!(play(&mut voice, &plane, &control(1.0), 4), [2.0, 3.0, 0.0, 0.0]);
        let mut beyond = voice_at(100, 200);
        assert_eq!(play(&mut beyond, &plane, &control(1.0), 4), [0.0; 4], "a zone that starts after the sample is silent");
        assert!(!beyond.is_active());
    }

    fn voice_at(start: i32, end: i32) -> Voice {voice(crate::zones::Zone {sample_start: start, sample_end: end, ..zone()})}

    #[test]
    fn an_end_before_the_start_plays_nothing() {
        let plane = ramp(16);
        let mut voice = voice_at(8, 2);
        assert_eq!(play(&mut voice, &plane, &control(1.0), 4), [0.0; 4]);
        assert!(!voice.is_active());
    }

    #[test]
    fn reverse_plays_from_the_end_to_the_start() {
        let plane = ramp(32);
        let mut voice = voice(crate::zones::Zone {sample_start: 4, sample_end: 8, reverse: true, ..zone()});
        assert_eq!(play(&mut voice, &plane, &control(1.0), 6), [7.0, 6.0, 5.0, 4.0, 0.0, 0.0]);
        assert!(!voice.is_active());
    }

    fn looped(mode: i32, fade: f32) -> crate::zones::Zone {
        crate::zones::Zone {loop_mode: mode, loop_start: 8, loop_end: 12, loop_fade: fade, sample_end: 16, ..zone()}
    }

    #[test]
    fn a_loop_repeats_its_frames() {
        let plane = ramp(16);
        let mut voice = voice(looped(LOOP_ALWAYS, 0.0));
        let rendered = play(&mut voice, &plane, &control(1.0), 20);
        assert_eq!(rendered[..12], [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0]);
        assert_eq!(rendered[12..], [8.0, 9.0, 10.0, 11.0, 8.0, 9.0, 10.0, 11.0]);
        assert!(voice.is_active());
    }

    #[test]
    fn loop_off_plays_through() {
        let plane = ramp(16);
        let mut voice = voice(looped(LOOP_OFF, 0.0));
        let rendered = play(&mut voice, &plane, &control(1.0), 20);
        assert_eq!(rendered[12..16], [12.0, 13.0, 14.0, 15.0]);
        assert!(!voice.is_active());
    }

    #[test]
    fn a_held_loop_plays_out_after_the_release() {
        let plane = ramp(16);
        let envelope = params(0, 1, 0, 0.5, 1.0, 1.0); // a release that never falls, to hear the positions
        let mut voice = voice(looped(LOOP_ON, 0.0));
        let (mut left, mut right) = (vec![0.0f32; 14], vec![0.0f32; 14]);
        voice.render([&plane, &plane], SR, &control(1.0), &envelope, &envelope, 1.0, &mut left, &mut right);
        assert_eq!(left[12..], [8.0, 9.0], "held, it loops");
        voice.note_off();
        let (mut left, mut right) = (vec![0.0f32; 8], vec![0.0f32; 8]);
        voice.render([&plane, &plane], SR, &control(1.0), &envelope, &envelope, 1.0, &mut left, &mut right);
        assert_eq!(left, [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 0.0, 0.0], "released, it leaves the loop and ends with the sample");
        assert!(!voice.is_active());
    }

    #[test]
    fn an_always_loop_keeps_looping_after_the_release() {
        let plane = ramp(16);
        let envelope = params(0, 1, 0, 0.5, 1.0, 1.0);
        let mut voice = voice(looped(LOOP_ALWAYS, 0.0));
        let (mut left, mut right) = (vec![0.0f32; 4], vec![0.0f32; 4]);
        voice.render([&plane, &plane], SR, &control(1.0), &envelope, &envelope, 1.0, &mut left, &mut right);
        voice.note_off();
        let (mut left, mut right) = (vec![0.0f32; 12], vec![0.0f32; 12]);
        voice.render([&plane, &plane], SR, &control(1.0), &envelope, &envelope, 1.0, &mut left, &mut right);
        assert_eq!(left[8..], [8.0, 9.0, 10.0, 11.0]);
    }

    #[test]
    fn a_reversed_loop_repeats_backwards() {
        let plane = ramp(16);
        let mut voice = voice(crate::zones::Zone {reverse: true, ..looped(LOOP_ALWAYS, 0.0)});
        let rendered = play(&mut voice, &plane, &control(1.0), 12);
        assert_eq!(rendered, [15.0, 14.0, 13.0, 12.0, 11.0, 10.0, 9.0, 8.0, 11.0, 10.0, 9.0, 8.0]);
    }

    #[test]
    fn an_alternating_loop_turns_around_at_its_points() {
        let plane = ramp(16);
        let mut voice = voice(crate::zones::Zone {loop_alternate: true, ..looped(LOOP_ALWAYS, 0.0)});
        let rendered = play(&mut voice, &plane, &control(1.0), 18);
        assert_eq!(rendered[8..], [8.0, 9.0, 10.0, 11.0, 10.0, 9.0, 8.0, 9.0, 10.0, 11.0]);
    }

    #[test]
    fn a_reversed_alternating_loop_starts_backwards() {
        let plane = ramp(16);
        let mut voice = voice(crate::zones::Zone {loop_alternate: true, reverse: true, ..looped(LOOP_ALWAYS, 0.0)});
        let rendered = play(&mut voice, &plane, &control(1.0), 14);
        assert_eq!(rendered, [15.0, 14.0, 13.0, 12.0, 11.0, 10.0, 9.0, 8.0, 9.0, 10.0, 11.0, 10.0, 9.0, 8.0]);
    }

    #[test]
    fn an_alternating_loop_needs_no_crossfade() {
        let plane = ramp(16);
        let mut voice = voice(crate::zones::Zone {loop_alternate: true, ..looped(LOOP_ALWAYS, 2.0 / SR)});
        let rendered = play(&mut voice, &plane, &control(1.0), 14);
        assert_eq!(rendered[8..], [8.0, 9.0, 10.0, 11.0, 10.0, 9.0]);
    }

    #[test]
    fn a_released_gate_loop_leaves_in_the_direction_of_the_zone() {
        let plane = ramp(16);
        let mut voice = voice(crate::zones::Zone {loop_alternate: true, ..looped(LOOP_ON, 0.0)});
        play(&mut voice, &plane, &control(1.0), 14);
        voice.note_off();
        assert_eq!(voice.position(), 8.0, "on its way back");
        play(&mut voice, &plane, &control(1.0), 3);
        assert_eq!(voice.position(), 11.0, "it went on backwards");
    }

    #[test]
    fn a_sounding_voice_follows_its_edited_loop() {
        let plane = ramp(16);
        let mut voice = voice(looped(LOOP_ALWAYS, 0.0));
        assert_eq!(play(&mut voice, &plane, &control(1.0), 10), [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]);
        voice.follow(crate::zones::Zone {loop_start: 4, loop_end: 14, ..looped(LOOP_ALWAYS, 0.0)});
        assert_eq!(play(&mut voice, &plane, &control(1.0), 6), [10.0, 11.0, 12.0, 13.0, 4.0, 5.0], "the position stays, the new loop wraps");
        voice.follow(crate::zones::Zone {loop_start: 4, loop_end: 8, ..looped(LOOP_ALWAYS, 0.0)});
        voice.follow(looped(LOOP_OFF, 0.0));
        play(&mut voice, &plane, &control(1.0), 20);
        assert!(!voice.is_active(), "with the loop switched off it plays to the end");
    }

    #[test]
    fn a_release_sample_stays_a_one_shot_when_its_zone_is_edited() {
        let mut voice = voice(looped(LOOP_OFF, 0.0));
        voice.mark_release_sample();
        voice.follow(looped(LOOP_ALWAYS, 0.0));
        assert!(voice.zone.one_shot && voice.zone.loop_mode == LOOP_OFF);
    }

    #[test]
    fn a_loop_shorter_than_four_frames_does_not_loop() {
        let plane = ramp(16);
        let mut voice = voice(crate::zones::Zone {loop_mode: LOOP_ALWAYS, loop_start: 8, loop_end: 10, sample_end: 16, ..zone()});
        play(&mut voice, &plane, &control(1.0), 20);
        assert!(!voice.is_active(), "it played through to the end");
    }

    #[test]
    fn a_loop_crossfade_blends_into_the_frames_before_the_loop() {
        let plane = ramp(16);
        let mut voice = voice(looped(LOOP_ALWAYS, 2.0 / SR));
        let rendered = play(&mut voice, &plane, &control(1.0), 14);
        assert_eq!(rendered[..10], [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]);
        assert_eq!(rendered[10], 10.0, "the fade starts at nothing");
        assert_eq!(rendered[11], 11.0 + (7.0 - 11.0) * 0.5, "halfway into the frame one loop length earlier");
        assert_eq!(rendered[12..], [8.0, 9.0], "and lands where the fade was heading");
    }

    #[test]
    fn a_loop_fade_never_reaches_before_the_sample_start() {
        let plane = ramp(16);
        let mut voice = voice(crate::zones::Zone {sample_start: 7, ..looped(LOOP_ALWAYS, 1.0)});
        let rendered = play(&mut voice, &plane, &control(1.0), 6);
        assert!(rendered.iter().all(|value| *value >= 7.0), "the fade is cut to the one frame before the loop: {rendered:?}");
    }

    #[test]
    fn a_note_released_before_it_sounded_stays_silent() {
        let plane = vec![1.0f32; 64];
        let mut voice = voice(zone());
        voice.note_off();
        assert_eq!(play(&mut voice, &plane, &control(1.0), 4), [0.0; 4]);
        assert!(!voice.is_active());
    }

    #[test]
    fn a_shifted_loop_start_stays_inside_the_loop() {
        let plane = ramp(32);
        let mut voice = voice(crate::zones::Zone {loop_mode: LOOP_ALWAYS, loop_start: 8, loop_end: 16, sample_end: 32, ..zone()});
        voice.loop_shift = 0.5;
        let rendered = play(&mut voice, &plane, &control(1.0), 20);
        assert_eq!(rendered[16..], [12.0, 13.0, 14.0, 15.0], "the loop now starts halfway");
        let mut beyond = super::tests::voice(crate::zones::Zone {loop_mode: LOOP_ALWAYS, loop_start: 8, loop_end: 16, sample_end: 32, ..zone()});
        beyond.loop_shift = 4.0;
        play(&mut beyond, &plane, &control(1.0), 40);
        assert!(!beyond.is_active(), "a loop start pushed onto its end leaves nothing to loop");
    }

    #[test]
    fn a_one_shot_ignores_the_note_off() {
        let plane = ramp(8);
        let mut voice = voice(crate::zones::Zone {one_shot: true, ..zone()});
        voice.note_off();
        assert!(!voice.is_released());
        assert_eq!(play(&mut voice, &plane, &control(1.0), 8), ramp(8));
    }

    #[test]
    fn a_fast_release_ends_even_a_one_shot() {
        let plane = vec![1.0f32; 4_800];
        let mut voice = voice(crate::zones::Zone {one_shot: true, ..zone()});
        play(&mut voice, &plane, &control(1.0), 4);
        voice.fast_release();
        let rendered = play(&mut voice, &plane, &control(1.0), 16);
        assert_eq!(rendered[0], 0.01);
        assert!(!voice.is_active(), "the fast factor of this test falls to silence within two frames");
    }

    #[test]
    fn the_amp_envelope_shapes_the_level() {
        let plane = vec![1.0f32; 64];
        let mut voice = voice(zone());
        let envelope = params(1, 2, 0, 0.5, 1.0, 0.5);
        let (mut left, mut right) = (vec![0.0f32; 4], vec![0.0f32; 4]);
        voice.render([&plane, &plane], SR, &control(1.0), &envelope, &envelope, 0.5, &mut left, &mut right);
        assert_eq!(left, [0.0, 0.5, 1.0, 1.0]);
    }

    #[test]
    fn a_voice_ends_when_its_amp_envelope_does() {
        let plane = vec![1.0f32; 4_800];
        let mut voice = voice(zone());
        play(&mut voice, &plane, &control(1.0), 2);
        voice.note_off();
        play(&mut voice, &plane, &control(1.0), 64);
        assert!(!voice.is_active());
    }

    #[test]
    fn a_sustain_of_nothing_ends_the_voice() {
        let plane = vec![1.0f32; 4_800];
        let mut voice = voice(zone());
        let envelope = params(0, 1, 0, 0.5, 0.0, 0.5);
        let (mut left, mut right) = (vec![0.0f32; 64], vec![0.0f32; 64]);
        voice.render([&plane, &plane], SR, &control(1.0), &envelope, &envelope, 0.5, &mut left, &mut right);
        assert!(!voice.is_active());
    }

    #[test]
    fn gains_glide_within_an_interval_and_start_where_they_are_set() {
        let plane = vec![1.0f32; 64];
        let mut voice = voice(zone());
        let first = Control {gain_left: 0.5, gain_right: 0.25, ..control(1.0)};
        let (mut left, mut right) = (vec![0.0f32; 4], vec![0.0f32; 4]);
        let envelope = instant();
        voice.render([&plane, &plane], SR, &first, &envelope, &envelope, 0.5, &mut left, &mut right);
        assert_eq!((left.clone(), right.clone()), (vec![0.5; 4], vec![0.25; 4]), "the first interval starts at its gains");
        let second = Control {gain_left: 1.0, gain_right: 0.25, ..control(1.0)};
        let (mut left, mut right) = (vec![0.0f32; 4], vec![0.0f32; 4]);
        voice.render([&plane, &plane], SR, &second, &envelope, &envelope, 0.5, &mut left, &mut right);
        assert_eq!(left, [0.625, 0.75, 0.875, 1.0]);
        assert_eq!(right, [0.25; 4]);
    }

    #[test]
    fn mono_folds_the_channels_together() {
        let (left_plane, right_plane) = (vec![1.0f32; 8], vec![0.0f32; 8]);
        let envelope = instant();
        for (mono, expected) in [(0.0, (1.0, 0.0)), (0.5, (0.75, 0.25)), (1.0, (0.5, 0.5))] {
            let mut voice = voice(zone());
            let (mut left, mut right) = (vec![0.0f32; 2], vec![0.0f32; 2]);
            voice.render([&left_plane, &right_plane], SR, &Control {mono, ..control(1.0)}, &envelope, &envelope, 0.5, &mut left, &mut right);
            assert_eq!((left[1], right[1]), expected, "mono {mono}");
        }
    }

    #[test]
    fn the_output_is_added_not_replaced() {
        let plane = vec![1.0f32; 8];
        let mut voice = voice(zone());
        let (mut left, mut right) = (vec![0.25f32; 2], vec![0.5f32; 2]);
        let envelope = instant();
        voice.render([&plane, &plane], SR, &control(1.0), &envelope, &envelope, 0.5, &mut left, &mut right);
        assert_eq!((left, right), (vec![1.25; 2], vec![1.5; 2]));
    }

    #[test]
    fn the_low_pass_24_is_steeper_than_the_12() {
        let plane: Vec<f32> = (0..4_800).map(|frame| if frame % 4 < 2 {1.0} else {-1.0}).collect();
        let coefficients = SvfCoefficients::new(500.0, 0.707, SR);
        let peak = |filter_type: i32| {
            let mut voice = voice(zone());
            let control = Control {filter_type, filter: coefficients, filter_second: coefficients, ..control(1.0)};
            play(&mut voice, &plane, &control, 4_000)[3_000..].iter().fold(0.0f32, |peak, value| peak.max(value.abs()))
        };
        assert!(peak(FILTER_OFF) > 0.9);
        assert!(peak(1) < 0.05);
        assert!(peak(FILTER_LOW_PASS_24) < peak(1) * 0.1);
    }

    #[test]
    fn a_glide_moves_the_pitch_to_the_played_key() {
        let plane = vec![1.0f32; 64];
        let mut voice = voice(zone());
        assert_eq!(voice.current_pitch(), 60.0, "no glide, no detour");
        voice.glide(48.0, 4);
        assert_eq!(voice.current_pitch(), 48.0);
        play(&mut voice, &plane, &control(1.0), 2);
        assert_eq!(voice.current_pitch(), 54.0);
        play(&mut voice, &plane, &control(1.0), 8);
        assert_eq!(voice.current_pitch(), 60.0);
    }

    #[test]
    fn the_start_shift_moves_the_start_within_the_zone() {
        let plane = ramp(32);
        let mut voice = voice(crate::zones::Zone {sample_start: 8, sample_end: 16, ..zone()});
        voice.start_shift = 0.5;
        assert_eq!(play(&mut voice, &plane, &control(1.0), 2), [12.0, 13.0]);
        let mut below = voice_at(8, 16);
        below.start_shift = -3.0;
        assert_eq!(play(&mut below, &plane, &control(1.0), 1), [8.0], "never before the zone's start");
        let mut above = voice_at(8, 16);
        above.start_shift = 3.0;
        play(&mut above, &plane, &control(1.0), 2);
        assert!(!above.is_active(), "at the end there is nothing left to play");
    }
}
