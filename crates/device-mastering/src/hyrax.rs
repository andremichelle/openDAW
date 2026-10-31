// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

//! Matchering's Hyrax brickwall limiter as a streaming processor. The offline original smooths the attack
//! envelope forwards and backwards (`filtfilt`); the backward pass is evaluated over `BACKWARD_ATTACKS` attack
//! lengths of lookahead, where its contribution has decayed below 1e-13. Allocation free, built in place.

pub const RING: usize = 8192;
const MASK: usize = RING - 1;
const BACKWARD_ATTACKS: usize = 16;
const ATTACK_MS: f64 = 1.0;
const HOLD_MS: f64 = 1.0;
const RELEASE_MS: f64 = 3000.0;
const ATTACK_FILTER_COEFFICIENT: f64 = -2.0;
const HOLD_FILTER_HZ: f64 = 7.0;
const RELEASE_FILTER_COEFFICIENT: f64 = 800.0;

struct MaxQueue {
    times: [usize; RING],
    values: [f64; RING],
    head: usize,
    tail: usize
}

impl MaxQueue {
    fn push(&mut self, time: usize, value: f64) {
        while self.tail != self.head && self.values[(self.tail - 1) & MASK] <= value {self.tail -= 1;}
        self.times[self.tail & MASK] = time;
        self.values[self.tail & MASK] = value;
        self.tail += 1;
    }

    fn expire(&mut self, oldest: usize) {
        while self.head != self.tail && self.times[self.head & MASK] < oldest {self.head += 1;}
    }

    fn max(&self) -> f64 {self.values[self.head & MASK]}
}

/// scipy `butter(1, cutoff, fs=sample_rate)` as `(b0 = b1, a1)`.
fn butterworth(cutoff: f64, sample_rate: f64) -> (f64, f64) {
    let warped = libm::tan(core::f64::consts::PI * cutoff / sample_rate);
    (warped / (1.0 + warped), (warped - 1.0) / (warped + 1.0))
}

pub struct Hyrax {
    threshold: f64,
    radius: usize,
    hold: usize,
    backward: usize,
    coefficient: f64,
    hold_filter: (f64, f64),
    release_filter: (f64, f64),
    audio: [[f32; RING]; 2],
    hard_clip: [f64; RING],
    forward: [f64; RING],
    release_gain: [f64; RING],
    attack_queue: MaxQueue,
    hold_queue: MaxQueue,
    forward_state: f64,
    hold_input: f64,
    hold_output: f64,
    release_input: f64,
    release_output: f64,
    time: usize
}

impl Hyrax {
    /// Build IN PLACE (the state block arrives zeroed).
    pub fn init(&mut self, sample_rate: f32, threshold: f64) {
        let sample_rate = sample_rate as f64;
        let attack = (sample_rate * ATTACK_MS * 1e-3) as usize;
        let odd = if attack & 1 == 0 {attack + 1} else {attack};
        self.threshold = threshold;
        self.radius = odd - 1;
        self.hold = (sample_rate * HOLD_MS * 1e-3) as usize;
        self.backward = BACKWARD_ATTACKS * attack;
        assert!(self.latency() + 128 < RING, "sample rate too high for the limiter lookahead");
        self.coefficient = libm::exp(ATTACK_FILTER_COEFFICIENT / attack as f64);
        self.hold_filter = butterworth(HOLD_FILTER_HZ, sample_rate);
        self.release_filter = butterworth(RELEASE_FILTER_COEFFICIENT / RELEASE_MS, sample_rate);
        self.time = RING;
    }

    pub fn latency(&self) -> usize {self.radius + self.backward}

    pub fn set_threshold(&mut self, threshold: f64) {self.threshold = threshold;}

    pub fn clear(&mut self) {
        self.audio.iter_mut().for_each(|channel| channel.fill(0.0));
        self.hard_clip.fill(0.0);
        self.forward.fill(0.0);
        self.release_gain.fill(0.0);
        self.attack_queue.head = 0;
        self.attack_queue.tail = 0;
        self.hold_queue.head = 0;
        self.hold_queue.tail = 0;
        self.forward_state = 0.0;
        self.hold_input = 0.0;
        self.hold_output = 0.0;
        self.release_input = 0.0;
        self.release_output = 0.0;
        self.time = RING;
    }

    fn ingest(&mut self, left: f32, right: f32) {
        let time = self.time;
        self.audio[0][time & MASK] = left;
        self.audio[1][time & MASK] = right;
        let peak = (left.abs().max(right.abs()) as f64).max(self.threshold) / self.threshold;
        let hard_clip = 1.0 - 1.0 / peak;
        self.hard_clip[time & MASK] = hard_clip;
        self.attack_queue.push(time, hard_clip);
        self.attack_queue.expire(time - 2 * self.radius);
        let center = time - self.radius;
        let slided = self.attack_queue.max();
        self.forward_state = (1.0 - self.coefficient) * slided + self.coefficient * self.forward_state;
        self.forward[center & MASK] = self.forward_state;
        self.hold_queue.push(center, slided);
        self.hold_queue.expire(center + 1 - self.hold);
        let held = self.hold_queue.max();
        let (b, a) = self.hold_filter;
        let hold_output = b * held + b * self.hold_input - a * self.hold_output;
        self.hold_input = held;
        self.hold_output = hold_output;
        let release_input = held.max(hold_output);
        let (b, a) = self.release_filter;
        let release_output = b * release_input + b * self.release_input - a * self.release_output;
        self.release_input = release_input;
        self.release_output = release_output;
        self.release_gain[center & MASK] = hold_output.max(release_output);
        self.time += 1;
    }

    /// Limits `left`/`right` in place, delayed by `latency()`. With `active` false the audio is only delayed.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], active: bool) {
        let count = left.len();
        let start = self.time;
        for index in 0..count {self.ingest(left[index], right[index]);}
        let first = start - self.latency();
        let last = self.time - 1 - self.radius;
        let mut backward = self.forward[last & MASK];
        for position in (first..last).rev() {
            backward = (1.0 - self.coefficient) * self.forward[position & MASK] + self.coefficient * backward;
            if position < first + count {
                let slot = position & MASK;
                let gain = if active {
                    1.0 - self.hard_clip[slot].max(backward).max(self.release_gain[slot])
                } else {1.0};
                left[position - first] = (self.audio[0][slot] as f64 * gain) as f32;
                right[position - first] = (self.audio[1][slot] as f64 * gain) as f32;
            }
        }
    }
}
