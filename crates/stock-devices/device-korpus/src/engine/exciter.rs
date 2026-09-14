//! Exciters, decoupled from any resonator: Strike (raised-cosine contact pulse, hardness =
//! contact time, window-gated crack noise) and Breath (the living breath: envelope, turbulence,
//! chiff, drift). Each tick() produces one mono excitation sample.

use libm::{cosf, expf, powf};

const PI: f32 = core::f32::consts::PI;

#[inline]
fn lcg(state: &mut u32) -> f32 {
    *state = state.wrapping_mul(1664525).wrapping_add(1013904223);
    (*state >> 8) as f32 / 8388608.0 - 1.0
}

pub struct Strike {
    pulse_remaining: usize,
    pulse_len: usize,
    pulse_gain: f32,
    noise_gain: f32,
    noise_state: u32,
}

impl Strike {
    pub const fn silent() -> Self {
        Self {pulse_remaining: 0, pulse_len: 4, pulse_gain: 0.0, noise_gain: 0.0,
            noise_state: 0x1234567}
    }

    /// Unit-area raised-cosine pulse (area stays 1.0 across hardness) plus window-gated noise.
    pub fn strike(&mut self, velocity: f32, hardness_knob: f32, sample_rate: f32) {
        let hardness = (hardness_knob * 0.75 + velocity * 0.35).clamp(0.0, 1.1);
        let contact_seconds = 0.009 * powf(0.028, hardness);
        let pulse_len = ((contact_seconds * sample_rate) as usize).max(4);
        let pulse_gain = 2.0 / pulse_len as f32 * velocity;
        self.pulse_remaining = pulse_len;
        self.pulse_len = pulse_len;
        self.pulse_gain = pulse_gain;
        self.noise_gain = pulse_gain * 0.35 * (0.3 + hardness_knob);
    }

    pub fn tick(&mut self) -> f32 {
        if self.pulse_remaining == 0 {
            return 0.0;
        }
        let t = 1.0 - self.pulse_remaining as f32 / self.pulse_len as f32;
        self.pulse_remaining -= 1;
        let window = 0.5 * (1.0 - cosf(2.0 * PI * t));
        self.pulse_gain * window + lcg(&mut self.noise_state) * self.noise_gain * window
    }
}

pub struct Breath {
    breath: f32,
    breath_target: f32,
    attack_coefficient: f32,
    release_coefficient: f32,
    gate: bool,
    chiff: f32,
    noise_state: u32,
    noise_lp: f32,
    noise_lp_state: f32,
    drift_state: f32,
    sample_rate: f32,
}

impl Breath {
    pub const fn silent() -> Self {
        Self {breath: 0.0, breath_target: 0.0, attack_coefficient: 0.001,
            release_coefficient: 0.001, gate: false, chiff: 0.0, noise_state: 0x7ee1a2b3,
            noise_lp: 0.2, noise_lp_state: 0.0, drift_state: 0.0, sample_rate: 48_000.0}
    }

    pub fn blow(&mut self, velocity: f32, brightness: f32, damping: f32, sample_rate: f32) {
        let attack_seconds = 0.018 + 0.05 * (1.0 - velocity);
        let release_seconds = 0.03 + 0.4 * damping;
        self.breath = 0.0;
        self.breath_target = 0.92 + 0.24 * velocity;
        self.attack_coefficient = 1.0 - expf(-1.0 / (attack_seconds * sample_rate));
        self.release_coefficient = 1.0 - expf(-1.0 / (release_seconds * sample_rate));
        self.gate = true;
        self.chiff = 1.0;
        self.noise_lp = 0.10 + 0.28 * brightness;
        self.noise_lp_state = 0.0;
        self.drift_state = 0.0;
        self.sample_rate = sample_rate;
    }

    pub fn release(&mut self) {
        self.gate = false;
    }

    /// Live knob feedback while blowing: brightness retargets the turbulence lowpass and damping
    /// retargets the release time. The attack already in flight keeps its note-on speed.
    pub fn adjust(&mut self, brightness: f32, damping: f32) {
        self.noise_lp = 0.10 + 0.28 * brightness;
        self.release_coefficient = 1.0 - expf(-1.0 / ((0.03 + 0.4 * damping) * self.sample_rate));
    }

    pub fn level(&self) -> f32 {
        self.breath
    }

    /// AC excitation only: the bank's DC zeros would eat raw pressure anyway — the output is
    /// breath-scaled turbulence (chiff transient included) with a slow drift wobble on its level.
    pub fn tick(&mut self) -> f32 {
        let coefficient = if self.gate {self.attack_coefficient} else {self.release_coefficient};
        let target = if self.gate {self.breath_target} else {0.0};
        self.breath += (target - self.breath) * coefficient;
        self.chiff *= 1.0 - 18.0 / self.sample_rate;
        let raw = lcg(&mut self.noise_state);
        self.noise_lp_state += self.noise_lp * (raw - self.noise_lp_state);
        self.drift_state += 0.00006 * (lcg(&mut self.noise_state) - self.drift_state);
        let turbulence = self.noise_lp_state * (0.35 + 2.5 * self.chiff);
        self.breath * turbulence * (1.0 + self.drift_state * 6.0)
    }
}
