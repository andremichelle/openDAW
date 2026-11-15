use crate::hit_envelope::HitEnvelope;
use crate::svf::{Svf, SvfCoefficients};
use std::f32::consts::{FRAC_PI_2, TAU};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Wave {
    Sine,
    Half,
    Rectified,
    Burst
}

impl Wave {
    /// `phase` in cycles, any value.
    #[inline]
    pub fn at(self, phase: f32) -> f32 {
        let wrapped = phase - phase.floor();
        match self {
            Wave::Sine => (wrapped * TAU).sin(),
            Wave::Half => if wrapped < 0.5 {(wrapped * TAU).sin()} else {0.0},
            Wave::Rectified => (wrapped * TAU).sin().abs() * 2.0 - 1.0,
            Wave::Burst => if wrapped < 0.5 {(wrapped * 2.0 * TAU).sin()} else {0.0}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum FoldPosition {
    BeforeGate,
    AfterGate
}

#[derive(Clone, Copy, Debug)]
pub struct Patch {
    pub ratio: f32,
    pub depth: f32,
    pub strike: f32,
    pub strike_decay: f32,
    pub feedback: f32,
    pub wave: Wave,
    pub fold: f32,
    pub fold_position: FoldPosition,
    pub decay: f32,
    pub glide: f32,
    pub velocity: f32,
    pub second_ratio: f32,
    pub second_depth: f32,
    pub sub: f32,
    pub sub_ratio: f32,
    pub sub_drive: f32,
    pub hold: bool
}

impl Patch {
    pub const BASE: Patch = Patch {
        ratio: 2.41,
        depth: 0.6,
        strike: 4.0,
        strike_decay: 0.14,
        feedback: 0.25,
        wave: Wave::Sine,
        fold: 0.0,
        fold_position: FoldPosition::BeforeGate,
        decay: 0.45,
        glide: 0.04,
        velocity: 0.7,
        second_ratio: 0.0,
        second_depth: 0.0,
        sub: 0.0,
        sub_ratio: 0.5,
        sub_drive: 0.0,
        hold: false
    };
}

const GATE_FLOOR_HZ: f32 = 80.0;
const GATE_SPAN: f32 = 200.0;
const FOLD_GAIN: f32 = 7.0;

pub struct Voice {
    patch: Patch,
    sample_rate: f32,
    carrier_phase: f32,
    modulator_phase: f32,
    second_phase: f32,
    sub_phase: f32,
    feedback_state: [f32; 2],
    pitch: f32,
    target_pitch: f32,
    glide_factor: f32,
    strike_envelope: HitEnvelope,
    gate_envelope: HitEnvelope,
    gate_filter: Svf,
    level: f32,
    strike_level: f32,
    held: u32,
    sounding: bool
}

impl Voice {
    /// `sample_rate` is the rate `next` runs at (the oversampled rate).
    pub fn new(patch: Patch, sample_rate: f32) -> Self {
        let mut strike_envelope = HitEnvelope::default();
        let mut gate_envelope = HitEnvelope::default();
        strike_envelope.set(0.0, 0.0, patch.strike_decay, sample_rate);
        gate_envelope.set(0.001, 0.0, patch.decay, sample_rate);
        let glide_factor = if patch.glide > 0.0 {1.0 - (-1.0 / (patch.glide * sample_rate)).exp()} else {1.0};
        Self {
            patch,
            sample_rate,
            carrier_phase: 0.0,
            modulator_phase: 0.0,
            second_phase: 0.0,
            sub_phase: 0.0,
            feedback_state: [0.0; 2],
            pitch: 60.0,
            target_pitch: 60.0,
            glide_factor,
            strike_envelope,
            gate_envelope,
            gate_filter: Svf::default(),
            level: 0.0,
            strike_level: 0.0,
            held: 0,
            sounding: false
        }
    }

    /// Takes effect at once, the envelopes keep their current value.
    pub fn set_patch(&mut self, patch: Patch) {
        self.patch = patch;
        self.glide_factor = if patch.glide > 0.0 {1.0 - (-1.0 / (patch.glide * self.sample_rate)).exp()} else {1.0};
        self.strike_envelope.set(0.0, 0.0, patch.strike_decay, self.sample_rate);
        self.gate_envelope.set(0.001, 0.0, patch.decay, self.sample_rate);
    }

    /// `pitch` in MIDI semitones, `velocity` 0 to 1. A note while another is held slides and keeps the envelopes.
    pub fn note_on(&mut self, pitch: f32, velocity: f32) {
        let legato = self.held > 0 && self.sounding;
        self.held += 1;
        self.target_pitch = pitch;
        if legato {return;}
        self.pitch = pitch;
        self.level = velocity;
        self.strike_level = self.patch.strike * (1.0 - self.patch.velocity + self.patch.velocity * velocity);
        self.strike_envelope.trigger(1.0);
        if self.patch.hold {self.gate_envelope.trigger_held(1.0);} else {self.gate_envelope.trigger(1.0);}
        self.sounding = true;
    }

    pub fn note_off(&mut self) {
        self.held = self.held.saturating_sub(1);
        if self.held == 0 {self.gate_envelope.release();}
    }

    #[inline]
    fn fold(&self, input: f32) -> f32 {
        if self.patch.fold <= 0.0 {input} else {(input * (1.0 + self.patch.fold * FOLD_GAIN) * FRAC_PI_2).sin()}
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        let Patch {ratio, depth, feedback, wave, second_ratio, second_depth, fold_position, sub, sub_ratio, sub_drive, ..} = self.patch;
        self.pitch += (self.target_pitch - self.pitch) * self.glide_factor;
        let frequency = 440.0 * ((self.pitch - 69.0) / 12.0).exp2();
        let step = frequency / self.sample_rate;
        let gate = self.gate_envelope.next();
        if self.gate_envelope.is_idle() {self.sounding = false;}
        let index = depth + self.strike_envelope.next() * self.strike_level;
        let feedback_phase = feedback * (self.feedback_state[0] + self.feedback_state[1]) * 0.5;
        let modulator = wave.at(self.modulator_phase + feedback_phase);
        self.feedback_state = [self.feedback_state[1], modulator];
        let second = if second_depth > 0.0 {wave.at(self.second_phase) * second_depth} else {0.0};
        let carrier = wave.at(self.carrier_phase + index * (modulator + second) / TAU);
        self.carrier_phase = (self.carrier_phase + step).fract();
        self.modulator_phase = (self.modulator_phase + step * ratio).fract();
        self.second_phase = (self.second_phase + step * second_ratio).fract();
        let sine = (self.sub_phase * TAU).sin();
        let body = if sub_drive > 0.0 {(sine * (1.0 + sub_drive * 4.0)).tanh()} else {sine} * sub;
        self.sub_phase = (self.sub_phase + step * sub_ratio).fract();
        let cutoff = GATE_FLOOR_HZ * GATE_SPAN.powf(gate.sqrt());
        let coefficients = SvfCoefficients::new(cutoff, 0.6, self.sample_rate);
        let level = gate * self.level;
        match fold_position {
            FoldPosition::BeforeGate => (self.gate_filter.process(self.fold(carrier), &coefficients).low + body) * level,
            FoldPosition::AfterGate => {
                let gated = self.gate_filter.process(carrier, &coefficients).low * level;
                self.fold(gated) + body * level
            }
        }
    }
}
