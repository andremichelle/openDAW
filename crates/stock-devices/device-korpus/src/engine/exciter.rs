//! Exciters, decoupled from any resonator: Strike (raised-cosine contact pulse, hardness =
//! contact time, window-gated crack noise) and Breath (the living breath: envelope, turbulence,
//! chiff, drift). Each tick() produces one mono excitation sample.

use libm::{cosf, expf, powf, sinf, sqrtf};

const PI: f32 = core::f32::consts::PI;
const CONTACT_LEVEL: f32 = 0.6;
const MASS_RANGE: f32 = 3.0; // Stroke spans a third to three times the default head
const OBJECT_MASS: f32 = 1.5; // the struck object's effective mass, in default heads
const PUSH_SECONDS: f32 = 0.0006; // the default head's release time; it grows as √mass

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
    contact: f32,
    contact_decay: f32,
    contact_bright: f32,
    contact_lp: f32,
    contact_hp: f32,
    contact_state: u32,
    push: f32,
    push_coefficient: f32,
    push_gain: f32,
    push_tail: usize,
}

impl Strike {
    pub const fn silent() -> Self {
        Self {pulse_remaining: 0, pulse_len: 4, pulse_gain: 0.0, noise_gain: 0.0,
            noise_state: 0x1234567, contact: 0.0, contact_decay: 0.0, contact_bright: 0.5,
            contact_lp: 0.0, contact_hp: 0.0, contact_state: 0x2468ace, push: 0.0, push_coefficient: 0.0,
            push_gain: 0.0, push_tail: 0}
    }

    /// Raised-cosine pulse of unit area across hardness, plus window-gated noise; weight scales the momentum.
    pub fn strike(&mut self, velocity: f32, hardness_knob: f32, stroke: f32, air: f32, sample_rate: f32) {
        let hardness = (hardness_knob * 0.75 + velocity * 0.35).clamp(0.0, 1.1);
        let contact_seconds = 0.009 * powf(0.028, hardness);
        let pulse_len = ((contact_seconds * sample_rate) as usize).max(4);
        let pulse_gain = 2.0 / pulse_len as f32 * velocity;
        // Weight moves only the momentum handed over; the felt's onset slope, and so the click, ignores mass.
        let mass = powf(MASS_RANGE, 2.0 * stroke - 1.0);
        let release = PUSH_SECONDS * sqrtf(mass);
        self.push = 0.0;
        self.push_gain = mass * (1.0 + OBJECT_MASS) / (mass + OBJECT_MASS) - 1.0;
        self.push_coefficient = 1.0 - expf(-1.0 / (release * sample_rate));
        self.push_tail = if self.push_gain == 0.0 {0} else {(12.0 * release * sample_rate) as usize};
        self.pulse_remaining = pulse_len + self.push_tail;
        self.pulse_len = pulse_len;
        self.pulse_gain = pulse_gain;
        self.noise_gain = pulse_gain * 0.35 * (0.3 + hardness_knob);
        // Air past its 0.5 balance adds the mallet's contact noise straight to the output.
        self.contact = CONTACT_LEVEL * velocity * (2.0 * air - 1.0).max(0.0);
        self.contact_decay = expf(-1.0 / ((0.002 + 0.01 * (1.1 - hardness)) * sample_rate));
        self.contact_bright = 0.2 + 0.7 * hardness / 1.1;
        self.contact_lp = 0.0;
        self.contact_hp = 0.0;
    }

    /// One sample of the direct contact noise: band-limited, decaying, brighter for harder mallets.
    pub fn contact(&mut self) -> f32 {
        if self.contact < 1.0e-6 {
            return 0.0;
        }
        self.contact_lp += self.contact_bright * (lcg(&mut self.contact_state) - self.contact_lp);
        self.contact_hp += 0.06 * (self.contact_lp - self.contact_hp);
        let sample = (self.contact_lp - self.contact_hp) * self.contact;
        self.contact *= self.contact_decay;
        sample
    }

    pub fn tick(&mut self) -> f32 {
        if self.pulse_remaining == 0 {
            return 0.0;
        }
        let pulse = if self.pulse_remaining > self.push_tail {
            let t = 1.0 - (self.pulse_remaining - self.push_tail) as f32 / self.pulse_len as f32;
            let window = 0.5 * (1.0 - cosf(2.0 * PI * t));
            self.pulse_gain * window + lcg(&mut self.noise_state) * self.noise_gain * window
        } else {
            0.0
        };
        self.pulse_remaining -= 1;
        self.push += self.push_coefficient * (pulse - self.push);
        pulse + self.push_gain * self.push
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
    pulse_phase: f32,
    pulse_ramp: f32,
    pulse_walk: f32,
    pulse_state: u32,
    age: f32,
    sample_rate: f32,
}

impl Breath {
    pub const fn silent() -> Self {
        Self {breath: 0.0, breath_target: 0.0, attack_coefficient: 0.001,
            release_coefficient: 0.001, gate: false, chiff: 0.0, noise_state: 0x7ee1a2b3,
            noise_lp: 0.2, noise_lp_state: 0.0, drift_state: 0.0, pulse_phase: 0.0,
            pulse_ramp: 0.0, pulse_walk: 0.0, pulse_state: 0x3d1f0c5b, age: 0.0,
            sample_rate: 48_000.0}
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
        self.pulse_phase = 0.0;
        self.pulse_ramp = 0.0;
        self.pulse_walk = 0.0;
        self.age = 0.0;
        self.sample_rate = sample_rate;
    }

    /// One sample of breath vibrato gain: a ~5Hz pulse with a wandering rate, easing in after the attack.
    pub fn pulse(&mut self, depth: f32) -> f32 {
        self.age += 1.0 / self.sample_rate;
        if self.gate && self.age > 0.3 {
            self.pulse_ramp = (self.pulse_ramp + 1.6 / self.sample_rate).min(1.0);
        }
        self.pulse_walk += 0.00004 * (lcg(&mut self.pulse_state) - self.pulse_walk);
        self.pulse_phase += 5.0 * (1.0 + 20.0 * self.pulse_walk) / self.sample_rate;
        if self.pulse_phase >= 1.0 {
            self.pulse_phase -= 1.0;
        }
        if depth <= 0.0 {
            return 1.0;
        }
        1.0 + depth * self.pulse_ramp * self.pulse_ramp * sinf(2.0 * PI * self.pulse_phase)
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
