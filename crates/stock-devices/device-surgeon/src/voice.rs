use crate::hit_envelope::HitEnvelope;
use crate::svf::{Svf, SvfCoefficients};
use core::f32::consts::{FRAC_PI_2, TAU};

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum Wave {
    #[default]
    Sine,
    Half,
    Rectified,
    Burst
}

impl Wave {
    /// `phase` in cycles, any value.
    #[inline]
    pub fn at(self, phase: f32) -> f32 {
        let wrapped = phase - libm::floorf(phase);
        match self {
            Wave::Sine => libm::sinf(wrapped * TAU),
            Wave::Half => if wrapped < 0.5 {libm::sinf(wrapped * TAU)} else {0.0},
            Wave::Rectified => libm::fabsf(libm::sinf(wrapped * TAU)) * 2.0 - 1.0,
            Wave::Burst => if wrapped < 0.5 {libm::sinf(wrapped * 2.0 * TAU)} else {0.0}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum FoldPlace {
    #[default]
    BeforeGate,
    AfterGate
}

/// The sound of one step, in the units the voice works with.
#[derive(Clone, Copy, Debug, Default)]
pub struct Patch {
    pub ratio: f32,
    pub depth: f32,
    pub strike: f32,
    pub strike_decay: f32,
    pub feedback: f32,
    pub wave: Wave,
    pub fold: f32,
    pub fold_place: FoldPlace,
    pub decay: f32,
    pub glide: f32,
    pub velocity: f32,
    pub second_ratio: f32,
    pub second_depth: f32,
    pub sine: f32,
    pub sine_ratio: f32,
    pub hold: bool
}

const GATE_FLOOR_HZ: f32 = 80.0;
const GATE_SPAN: f32 = 200.0;
const GATE_ATTACK: f32 = 0.001;
const FOLD_GAIN: f32 = 7.0;
// a step change settles within about 2 ms while the previous note still rings (no click)
const SETTLE: f32 = 0.0005;

// the values that would click when they step: level, strike depth, depth, feedback, second depth, fold, sine gain
const LEVEL: usize = 0;
const STRIKE: usize = 1;
const DEPTH: usize = 2;
const FEEDBACK: usize = 3;
const SECOND: usize = 4;
const FOLD: usize = 5;
const SINE: usize = 6;
const SMOOTHED: usize = 7;

#[derive(Clone, Copy, Debug, Default)]
pub struct Voice {
    patch: Patch,
    sample_rate: f32,
    carrier_phase: f32,
    modulator_phase: f32,
    second_phase: f32,
    sine_phase: f32,
    feedback_state: [f32; 2],
    pitch: f32,
    target_pitch: f32,
    glide_factor: f32,
    strike_envelope: HitEnvelope,
    gate_envelope: HitEnvelope,
    gate_filter: Svf,
    targets: [f32; SMOOTHED],
    values: [f32; SMOOTHED],
    settle: f32,
    held: u32,
    sounding: bool,
    slide_remaining: u32,
    started: bool
}

impl Voice {
    /// `sample_rate` is the rate `next` runs at (the oversampled rate). Call on a zeroed voice.
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        self.glide_factor = 1.0;
        self.settle = 1.0 - libm::expf(-1.0 / (SETTLE * sample_rate));
    }

    /// Takes effect at once when nothing sounds, otherwise the values that would click settle within 2 ms. The
    /// envelopes keep their current value.
    pub fn set_patch(&mut self, patch: Patch) {
        self.patch = patch;
        for (index, target) in [(DEPTH, patch.depth), (FEEDBACK, patch.feedback), (SECOND, patch.second_depth), (FOLD, patch.fold), (SINE, patch.sine)] {
            self.targets[index] = target;
            if !self.sounding {self.values[index] = target;}
        }
        self.glide_factor = if patch.glide > 0.0 {1.0 - libm::expf(-1.0 / (patch.glide * self.sample_rate))} else {1.0};
        self.strike_envelope.set(0.0, 0.0, patch.strike_decay, self.sample_rate);
        self.gate_envelope.set(GATE_ATTACK, 0.0, patch.decay, self.sample_rate);
    }

    /// `pitch` in MIDI semitones (fractions welcome), `velocity` 0 to 1. A note while another is held (a tie) keeps
    /// the envelopes. With `slide` above zero the pitch glides evenly from where it is to the new pitch over that
    /// many samples, tied or not.
    pub fn note_on(&mut self, pitch: f32, velocity: f32, slide: u32) {
        let legato = self.held > 0 && self.sounding;
        let sliding = slide > 0 && self.started;
        self.held += 1;
        self.target_pitch = pitch;
        self.slide_remaining = if sliding {slide} else {0};
        self.started = true;
        if legato {return;}
        if !sliding {self.pitch = pitch;}
        let strike = self.patch.strike * (1.0 - self.patch.velocity + self.patch.velocity * velocity);
        for (index, target) in [(LEVEL, velocity), (STRIKE, strike)] {
            self.targets[index] = target;
            if !self.sounding {self.values[index] = target;}
        }
        if self.sounding {self.strike_envelope.set(SETTLE * 4.0, 0.0, self.patch.strike_decay, self.sample_rate);}
        self.strike_envelope.trigger(1.0);
        if self.patch.hold {self.gate_envelope.trigger_held(1.0);} else {self.gate_envelope.trigger(1.0);}
        self.sounding = true;
    }

    pub fn note_off(&mut self) {
        self.held = self.held.saturating_sub(1);
        if self.held == 0 {self.gate_envelope.release();}
    }

    /// Moves the pitch of the sounding note, at the patch's glide.
    pub fn glide_to(&mut self, pitch: f32) {
        self.target_pitch = pitch;
        self.slide_remaining = 0;
    }

    /// Lets go of every held note, the tail rings out.
    pub fn release_all(&mut self) {
        self.held = 0;
        self.gate_envelope.release();
    }

    pub fn is_idle(&self) -> bool {!self.sounding}

    #[inline]
    fn fold(&self, input: f32) -> f32 {
        let fold = self.values[FOLD];
        if fold <= 0.0 {input} else {libm::sinf(input * (1.0 + fold * FOLD_GAIN) * FRAC_PI_2)}
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        let Patch {ratio, wave, second_ratio, fold_place, sine_ratio, ..} = self.patch;
        for index in 0..SMOOTHED {self.values[index] += (self.targets[index] - self.values[index]) * self.settle;}
        let [level, strike, depth, feedback, second_depth, _, sine] = self.values;
        if self.slide_remaining > 0 {
            self.pitch += (self.target_pitch - self.pitch) / self.slide_remaining as f32;
            self.slide_remaining -= 1;
        } else {
            self.pitch += (self.target_pitch - self.pitch) * self.glide_factor;
        }
        let frequency = 440.0 * libm::exp2f((self.pitch - 69.0) / 12.0);
        let step = frequency / self.sample_rate;
        let gate = self.gate_envelope.next();
        if self.gate_envelope.is_idle() {self.sounding = false;}
        let index = depth + self.strike_envelope.next() * strike;
        let feedback_phase = feedback * (self.feedback_state[0] + self.feedback_state[1]) * 0.5;
        let modulator = wave.at(self.modulator_phase + feedback_phase);
        self.feedback_state = [self.feedback_state[1], modulator];
        let second = if second_depth > 0.0 {wave.at(self.second_phase) * second_depth} else {0.0};
        let carrier = wave.at(self.carrier_phase + index * (modulator + second) / TAU);
        self.carrier_phase = fract(self.carrier_phase + step);
        self.modulator_phase = fract(self.modulator_phase + step * ratio);
        self.second_phase = fract(self.second_phase + step * second_ratio);
        let body = libm::sinf(self.sine_phase * TAU) * sine;
        self.sine_phase = fract(self.sine_phase + step * sine_ratio);
        let cutoff = GATE_FLOOR_HZ * libm::powf(GATE_SPAN, libm::sqrtf(gate));
        let coefficients = SvfCoefficients::new(cutoff, 0.6, self.sample_rate);
        let level = gate * level;
        match fold_place {
            FoldPlace::BeforeGate => (self.gate_filter.process(self.fold(carrier), &coefficients).low + body) * level,
            FoldPlace::AfterGate => {
                let gated = self.gate_filter.process(carrier, &coefficients).low * level;
                self.fold(gated) + body * level
            }
        }
    }
}

#[inline]
fn fract(value: f32) -> f32 {value - libm::truncf(value)}
