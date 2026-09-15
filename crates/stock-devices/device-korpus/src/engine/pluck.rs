//! Plucked string: dual-polarization waveguide (detuned pair mixed L/R), stiffness dispersion via
//! an allpass cascade (nylon -> piano on one knob), pick-position combing, pick-color filtering,
//! and a commuted synthetic body — the body impulse response is read through the pick filter as
//! the excitation (JOS commuted synthesis), so every note rings through a body at no runtime cost.
//! Zero-allocation: fixed delay lines, re-initialised in place at note-on; the body table is built
//! once per device.

use libm::{atan2f, cosf, fabsf, powf, sinf, sqrtf};

const PI: f32 = core::f32::consts::PI;
const MAX_DELAY: usize = 4096;
pub const BODY_LEN: usize = 2400;

const BODY_MODES: [(f32, f32, f32); 8] = [(96.0, 0.22, 1.0), (189.0, 0.16, 0.8), (247.0, 0.14, 0.7),
    (405.0, 0.10, 0.55), (532.0, 0.08, 0.4), (748.0, 0.06, 0.33), (1120.0, 0.05, 0.25),
    (1630.0, 0.04, 0.18)];

/// Builds the synthetic body impulse response in place (called once from device `init`).
pub fn build_body(table: &mut [f32; BODY_LEN], sample_rate: f32) {
    table.fill(0.0);
    for (frequency, t60, amp) in BODY_MODES {
        let omega = 2.0 * PI * frequency / sample_rate;
        let r = powf(10.0, -3.0 / (t60 * sample_rate));
        let (mut y1, mut y2) = (0.0f32, 0.0f32);
        for (index, slot) in table.iter_mut().enumerate() {
            let input = if index == 0 {1.0} else {0.0};
            let y = 2.0 * r * cosf(omega) * y1 - r * r * y2 + input;
            y2 = y1;
            y1 = y;
            *slot += y * amp;
        }
    }
    let peak = table.iter().fold(0.0f32, |acc, sample| acc.max(fabsf(*sample))).max(1.0e-9);
    for slot in table.iter_mut() {
        *slot /= peak;
    }
}

struct Polarization {
    line: [f32; MAX_DELAY],
    write: usize,
    length: f32,
    length_target: f32,
    damp_state: f32,
    damp_coefficient: f32,
    loop_gain: f32,
    ap_states: [f32; 4],
    ap_coefficient: f32,
    frequency: f32,
    sample_rate: f32,
}

impl Polarization {
    const fn silent() -> Self {
        Self {line: [0.0; MAX_DELAY], write: 0, length: 100.0, length_target: 100.0,
            damp_state: 0.0, damp_coefficient: 0.5, loop_gain: 0.0, ap_states: [0.0; 4],
            ap_coefficient: 0.0, frequency: 220.0, sample_rate: 48_000.0}
    }

    // Exact phase delay (samples) of the 4-stage stiffness allpass plus the damping one-pole at
    // the fundamental — any unmodeled loop delay is a flat-tuning error that grows with pitch.
    fn filter_delay(&self, frequency: f32) -> f32 {
        let omega = (2.0 * PI * frequency / self.sample_rate).max(1.0e-4);
        let (s, c) = (sinf(omega), cosf(omega));
        let ap = self.ap_coefficient;
        let ap_phase = atan2f(-s, ap + c) - atan2f(-ap * s, 1.0 + ap * c);
        let keep = 1.0 - self.damp_coefficient;
        let damp_phase = -atan2f(keep * s, 1.0 - keep * c);
        -(4.0 * ap_phase + damp_phase) / omega
    }

    // The damping one-pole's gain at the fundamental; the loop divides it out (bounded, loop < 1).
    fn damp_gain_at(&self, frequency: f32) -> f32 {
        let omega = (2.0 * PI * frequency / self.sample_rate).max(1.0e-4);
        let keep = 1.0 - self.damp_coefficient;
        let (s, c) = (sinf(omega), cosf(omega));
        self.damp_coefficient / sqrtf((1.0 - keep * c) * (1.0 - keep * c) + keep * s * keep * s)
    }

    fn init(&mut self, frequency: f32, sample_rate: f32, stiffness: f32, brightness: f32, t60: f32) {
        self.line.fill(0.0);
        self.write = 0;
        self.damp_state = 0.0;
        self.ap_states = [0.0; 4];
        self.ap_coefficient = -0.55 * stiffness;
        // More brightness = lighter loop damping (higher coefficient = higher cutoff).
        self.damp_coefficient = 0.12 + 0.62 * brightness;
        self.frequency = frequency;
        self.sample_rate = sample_rate;
        self.length = (sample_rate / frequency - self.filter_delay(frequency))
            .clamp(2.0, (MAX_DELAY - 4) as f32);
        self.length_target = self.length;
        self.loop_gain = (powf(10.0, -3.0 / (frequency * t60))
            / self.damp_gain_at(frequency).max(0.5)).min(0.998);
    }

    /// Live retune against the note-on frequency: the delay glides toward the target per sample
    /// inside tick() (a chunk-rate length step reads a distant tap and clicks), the loop gain
    /// keeps T60 correct at the shifted pitch.
    fn retune(&mut self, freq_ratio: f32, t60: f32) {
        let frequency = self.frequency * freq_ratio;
        self.length_target = (self.sample_rate / frequency - self.filter_delay(frequency))
            .clamp(2.0, (MAX_DELAY - 4) as f32);
        self.loop_gain = (powf(10.0, -3.0 / (frequency * t60))
            / self.damp_gain_at(frequency).max(0.5)).min(0.998);
    }

    #[inline]
    fn read(&self, delay: f32) -> f32 {
        let read_pos = self.write as f32 - delay + MAX_DELAY as f32;
        let index = read_pos as usize;
        let frac = read_pos - index as f32;
        let a = self.line[index % MAX_DELAY];
        let b = self.line[(index + 1) % MAX_DELAY];
        a + (b - a) * frac
    }

    #[inline]
    fn tick(&mut self, input: f32, release_damp: f32) -> f32 {
        self.length += (self.length_target - self.length) * 0.002;
        let raw = self.read(self.length);
        self.damp_state += self.damp_coefficient * (raw - self.damp_state);
        let mut signal = self.damp_state * self.loop_gain * release_damp;
        for state in &mut self.ap_states {
            let output = self.ap_coefficient * signal + *state;
            *state = signal - self.ap_coefficient * output;
            signal = output;
        }
        self.line[self.write % MAX_DELAY] = signal + input;
        self.write = (self.write + 1) % MAX_DELAY;
        signal
    }
}

// The pluck damping law — note-on and live must share one definition.
fn t60_of(damping: f32) -> f32 {
    0.4 + 7.0 * damping * damping
}

// Polarization mix per channel: width 0 = mono, 0.6 = 0.72/0.28, 1 = 0.87/0.13.
fn mix_major(width: f32) -> f32 {
    0.5 + width * (0.22 / 0.6)
}

pub struct PluckState {
    vertical: Polarization,
    horizontal: Polarization,
    excitation_pos: usize,
    excitation_gain: f32,
    pick_lp: f32,
    pick_state: f32,
    pick_delayed: f32,
    position_delay: f32,
    mix_major: f32,
    released: bool,
    dc_l: (f32, f32),
    dc_r: (f32, f32),
    live_freq: f32,
    live_damping: f32,
    live_width: f32,
}

impl PluckState {
    pub const fn silent() -> Self {
        Self {vertical: Polarization::silent(), horizontal: Polarization::silent(),
            excitation_pos: BODY_LEN, excitation_gain: 0.0, pick_lp: 0.5, pick_state: 0.0,
            pick_delayed: 0.0, position_delay: 20.0, mix_major: 0.72, released: false,
            dc_l: (0.0, 0.0), dc_r: (0.0, 0.0), live_freq: 1.0, live_damping: 0.5,
            live_width: 0.6}
    }

    #[allow(clippy::too_many_arguments)]
    pub fn pluck(&mut self, frequency: f32, velocity: f32, stiffness: f32, brightness: f32,
                 damping: f32, position: f32, width: f32, sample_rate: f32) {
        let t60 = t60_of(damping);
        let detune = 1.0 + 0.0009 * 0.75;
        self.vertical.init(frequency, sample_rate, stiffness, brightness, t60);
        self.horizontal.init(frequency * detune, sample_rate, stiffness, brightness, t60 * 0.72);
        self.excitation_pos = 0;
        // The body resonances boost low fundamentals; trim below 220Hz to keep the keyboard even.
        self.excitation_gain = velocity * 0.85 * powf((frequency * (1.0 / 220.0)).min(1.0), 0.9);
        self.pick_lp = 0.08 + 0.85 * brightness * (0.5 + 0.5 * velocity);
        self.pick_state = 0.0;
        self.pick_delayed = 0.0;
        self.position_delay = (0.04 + 0.42 * position) * self.vertical.length;
        self.mix_major = mix_major(width);
        self.released = false;
        self.dc_l = (0.0, 0.0);
        self.dc_r = (0.0, 0.0);
        self.live_freq = 1.0;
        self.live_damping = damping;
        self.live_width = width;
    }

    pub fn release(&mut self) {
        self.released = true;
    }

    /// Live knob feedback on a sounding string: tune glides the delay lines, damping retargets
    /// the loop gain, width re-blends the polarizations. Values arrive already smoothed; work
    /// runs only on movement.
    pub fn refresh(&mut self, freq_ratio: f32, damping: f32, width: f32) {
        if fabsf(width - self.live_width) > 1.0e-4 {
            self.live_width = width;
            self.mix_major = mix_major(width);
        }
        let moved = fabsf(freq_ratio - self.live_freq) > 1.0e-4
            || fabsf(damping - self.live_damping) > 1.0e-4;
        if !moved {
            return;
        }
        self.live_freq = freq_ratio;
        self.live_damping = damping;
        let t60 = t60_of(damping);
        self.vertical.retune(freq_ratio, t60);
        self.horizontal.retune(freq_ratio, t60 * 0.72);
    }

    #[inline]
    fn dc_block(state: &mut (f32, f32), input: f32) -> f32 {
        let output = input - state.0 + 0.995 * state.1;
        state.0 = input;
        state.1 = output;
        output
    }

    #[inline]
    fn excitation_at(&self, body: &[f32; BODY_LEN], index: f32) -> f32 {
        if index < 0.0 {return 0.0}
        let position = index as usize;
        if position >= BODY_LEN {return 0.0}
        let fade = if position + 240 > BODY_LEN {(BODY_LEN - position) as f32 / 240.0} else {1.0};
        body[position] * fade
    }

    /// Renders additively; returns the chunk peak so the caller can free silent voices.
    pub fn render(&mut self, body: &[f32; BODY_LEN], out_l: &mut [f32], out_r: &mut [f32]) -> f32 {
        let release_damp = if self.released {0.72} else {1.0};
        let mut peak = 0.0f32;
        for index in 0..out_l.len() {
            let mut input = 0.0f32;
            if self.excitation_pos < BODY_LEN {
                // Both comb taps run through the same pick filter: brightness is tone only,
                // the pick-position comb (fixed depth) belongs to the Position knob.
                let raw = self.excitation_at(body, self.excitation_pos as f32);
                let delayed = self.excitation_at(body, self.excitation_pos as f32 - self.position_delay);
                self.pick_state += self.pick_lp * (raw - self.pick_state);
                self.pick_delayed += self.pick_lp * (delayed - self.pick_delayed);
                input = (self.pick_state - 0.55 * self.pick_delayed) * self.excitation_gain;
                self.excitation_pos += 1;
            }
            let v = self.vertical.tick(input, release_damp);
            let h = self.horizontal.tick(input * 0.6, release_damp);
            let major = self.mix_major;
            let minor = 1.0 - major;
            let left = Self::dc_block(&mut self.dc_l, v * major + h * minor) * 1.85;
            let right = Self::dc_block(&mut self.dc_r, v * minor + h * major) * 1.85;
            out_l[index] += left;
            out_r[index] += right;
            peak = peak.max(fabsf(left)).max(fabsf(right));
        }
        peak
    }
}
