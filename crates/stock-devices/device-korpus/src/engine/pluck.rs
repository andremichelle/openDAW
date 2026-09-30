//! Plucked string: dual-polarization waveguide (detuned pair mixed L/R), stiffness dispersion via
//! an allpass cascade (object A picks the string type), pick-position combing, pick-color filtering,
//! and a commuted synthetic body — the body impulse response is read through the pick filter as
//! the excitation (JOS commuted synthesis), so every note rings through a body at no runtime cost.
//! Zero-allocation: fixed delay lines, re-initialised in place at note-on; the body table is built
//! once per device.

use libm::{atan2f, cosf, expf, fabsf, floorf, powf, sinf, sqrtf};

use crate::engine::tables::Material;

const PI: f32 = core::f32::consts::PI;
const MAX_DELAY: usize = 4096;
pub const BODY_LEN: usize = 2400;
const SCRAPE_LEVEL: f32 = 0.5;
const VIBRATO_RANGE: f32 = 0.0116; // ±20 cents at full knob
const TWANG: f32 = 0.088; // a full-depth steel pluck at velocity 1 starts 78 cents sharp
const TWANG_TIME: f32 = 0.028; // seconds at 220Hz, shorter as the string's round trips quicken
const BITE_TIME: f32 = 0.12;

// Object A picks the string; `horizontal` is that polarization's T60 relative to the vertical one.
struct StringType {
    stiffness: f32,
    detune: f32,
    t60: f32,
    lift: f32,
    pick: f32,
    horizontal: f32,
    twang: f32,
}

fn string_type(material: Material) -> StringType {
    match material {
        Material::Marimba => StringType {stiffness: 0.08, detune: 0.0009 * 0.75, t60: 1.0, lift: 0.0,
            pick: 0.0, horizontal: 0.72, twang: 0.5}, // nylon
        Material::Vibraphone => StringType {stiffness: 0.22, detune: 0.0012, t60: 1.6, lift: 0.14,
            pick: 0.12, horizontal: 0.72, twang: 1.0}, // steel
        Material::Bell => StringType {stiffness: 0.38, detune: 0.0035, t60: 1.3, lift: 0.2,
            pick: 0.18, horizontal: 0.72, twang: 0.8}, // chime
        Material::Membrane => StringType {stiffness: 0.1, detune: 0.001, t60: 0.45, lift: 0.24,
            pick: 0.25, horizontal: 0.72, twang: 1.0}, // banjo
        Material::Plate => StringType {stiffness: 0.14, detune: 0.0009, t60: 0.9, lift: 0.2,
            pick: 0.2, horizontal: 2.5, twang: 0.9}, // steel-string acoustic guitar
        Material::PianoWire => StringType {stiffness: 0.7, detune: 0.0009 * 0.75, t60: 1.0, lift: 0.0,
            pick: 0.0, horizontal: 0.72, twang: 0.6}, // stiff wire
    }
}

#[inline]
fn lcg(state: &mut u32) -> f32 {
    *state = state.wrapping_mul(1664525).wrapping_add(1013904223);
    (*state >> 8) as f32 / 8388608.0 - 1.0
}

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

    fn init(&mut self, frequency: f32, sample_rate: f32, stiffness: f32, brightness: f32, lift: f32,
            t60: f32, cap: f32) {
        self.line.fill(0.0);
        self.write = 0;
        self.damp_state = 0.0;
        self.ap_states = [0.0; 4];
        self.ap_coefficient = -0.55 * stiffness;
        // More brightness = lighter loop damping (higher coefficient = higher cutoff).
        self.damp_coefficient = (0.12 + 0.62 * brightness + lift).min(0.95);
        self.frequency = frequency;
        self.sample_rate = sample_rate;
        self.length = (sample_rate / frequency - self.filter_delay(frequency))
            .clamp(2.0, (MAX_DELAY - 4) as f32);
        self.length_target = self.length;
        self.loop_gain = (powf(10.0, -3.0 / (frequency * t60))
            / self.damp_gain_at(frequency).max(0.5)).min(cap);
    }

    /// Live retune against the note-on frequency: the delay glides toward the target per sample
    /// inside tick() (a chunk-rate length step reads a distant tap and clicks), the loop gain
    /// keeps T60 correct at the shifted pitch.
    fn retune(&mut self, freq_ratio: f32, t60: f32, cap: f32) {
        let frequency = self.frequency * freq_ratio;
        self.length_target = (self.sample_rate / frequency - self.filter_delay(frequency))
            .clamp(2.0, (MAX_DELAY - 4) as f32);
        self.loop_gain = (powf(10.0, -3.0 / (frequency * t60))
            / self.damp_gain_at(frequency).max(0.5)).min(cap);
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
    fn tick(&mut self, input: f32, release_damp: f32, bend: f32) -> f32 {
        self.length += (self.length_target - self.length) * 0.002;
        let raw = self.read((self.length * bend).min((MAX_DELAY - 2) as f32));
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
    let open = openness(damping);
    0.4 + 7.0 * damping * damping + 8.0 * open * open
}

// Above 70% the knob opens toward a free string; below, the old law holds bit for bit.
fn openness(damping: f32) -> f32 {
    (damping - 0.7).max(0.0) * (1.0 / 0.3)
}

// The loop-gain ceiling follows the opening so long targets survive at higher pitches too.
fn gain_cap(damping: f32) -> f32 {
    let open = openness(damping);
    0.998 + 0.0010 * open * open
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
    t60_scale: f32,
    horizontal_t60: f32,
    scrape: f32,
    scrape_decay: f32,
    scrape_lp: f32,
    scrape_hp: f32,
    scrape_color: f32,
    noise_state: u32,
    vibrato_depth: f32,
    vib_phase: f32,
    vib_ramp: f32,
    vib_walk: f32,
    twang: f32,
    twang_decay: f32,
    body_lead: f32,
    bent_state: f32,
    bent_delayed: f32,
    bite: f32,
    bite_decay: f32,
    age: f32,
    sample_rate: f32,
}

impl PluckState {
    pub const fn silent() -> Self {
        Self {vertical: Polarization::silent(), horizontal: Polarization::silent(),
            excitation_pos: BODY_LEN, excitation_gain: 0.0, pick_lp: 0.5, pick_state: 0.0,
            pick_delayed: 0.0, position_delay: 20.0, mix_major: 0.72, released: false,
            dc_l: (0.0, 0.0), dc_r: (0.0, 0.0), live_freq: 1.0, live_damping: 0.5,
            live_width: 0.6, t60_scale: 1.0, horizontal_t60: 0.72, scrape: 0.0, scrape_decay: 0.0,
            scrape_lp: 0.0, scrape_hp: 0.0, scrape_color: 0.5, noise_state: 0x6a09e667, vibrato_depth: 0.0,
            vib_phase: 0.0, vib_ramp: 0.0, vib_walk: 0.0, twang: 0.0, twang_decay: 0.0, body_lead: 0.0,
            bent_state: 0.0, bent_delayed: 0.0, bite: 0.0, bite_decay: 0.0, age: 0.0, sample_rate: 48_000.0}
    }

    #[allow(clippy::too_many_arguments)]
    pub fn pluck(&mut self, material: Material, frequency: f32, velocity: f32, brightness: f32,
                 damping: f32, position: f32, width: f32, vibrato: f32, air: f32, stroke: f32,
                 sample_rate: f32) {
        let string = string_type(material);
        let t60 = t60_of(damping) * string.t60;
        let cap = gain_cap(damping);
        let detune = 1.0 + string.detune;
        // An opening string evens its polarizations, so the two decay stages converge.
        let horizontal = powf(string.horizontal, 1.0 - 0.45 * openness(damping));
        self.vertical.init(frequency, sample_rate, string.stiffness, brightness, string.lift, t60, cap);
        self.horizontal.init(frequency * detune, sample_rate, string.stiffness, brightness,
            string.lift, t60 * horizontal, cap);
        self.excitation_pos = 0;
        // Stroke is pluck depth: how far the pick pulls the string before it slips off.
        let deep = stroke - 0.5;
        let depth = 1.0 + deep * (0.3 - 0.2 * deep);
        // The body resonances boost low fundamentals; trim below 220Hz to keep the keyboard even.
        self.excitation_gain = velocity * 0.85 * powf((frequency * (1.0 / 220.0)).min(1.0), 0.9) * depth;
        self.pick_lp = (0.08 + 0.85 * brightness * (0.5 + 0.5 * velocity) + string.pick).min(0.98);
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
        self.t60_scale = string.t60;
        self.horizontal_t60 = string.horizontal;
        // Air past its 0.5 balance adds pick noise, into the string and straight out.
        self.scrape = SCRAPE_LEVEL * velocity * (2.0 * air - 1.0).max(0.0);
        self.scrape_decay = expf(-1.0 / (0.012 * sample_rate));
        self.scrape_color = 0.3 + 0.6 * brightness;
        self.scrape_lp = 0.0;
        self.scrape_hp = 0.0;
        self.vibrato_depth = vibrato;
        self.vib_phase = 0.0;
        self.vib_ramp = 0.0;
        self.vib_walk = 0.0;
        // Pulled past the default, the stretched string starts sharp and settles as the stretch relaxes.
        self.twang = TWANG * string.twang * velocity * deep.max(0.0);
        self.twang_decay = expf(-1.0 / (TWANG_TIME * sqrtf(220.0 / frequency) * sample_rate));
        // The pick releases a twanging string late by exactly the phase its sharp start gains back.
        self.body_lead = -self.twang / (1.0 - self.twang_decay);
        self.bent_state = 0.0;
        self.bent_delayed = 0.0;
        // A shallow stroke moves the string along the top: less of the body-driven first stage.
        self.bite = deep * (0.55 - 0.5 * deep);
        self.bite_decay = expf(-1.0 / (BITE_TIME * sample_rate));
        self.age = 0.0;
        self.sample_rate = sample_rate;
    }

    pub fn release(&mut self) {
        self.released = true;
    }

    /// Live knob feedback on a sounding string: tune glides the delay lines, damping retargets
    /// the loop gain, width re-blends the polarizations. Values arrive already smoothed; work
    /// runs only on movement.
    pub fn refresh(&mut self, freq_ratio: f32, damping: f32, width: f32, vibrato: f32) {
        self.vibrato_depth = vibrato;
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
        let t60 = t60_of(damping) * self.t60_scale;
        let cap = gain_cap(damping);
        let horizontal = powf(self.horizontal_t60, 1.0 - 0.45 * openness(damping));
        self.vertical.retune(freq_ratio, t60, cap);
        self.horizontal.retune(freq_ratio, t60 * horizontal, cap);
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

    #[inline]
    fn excitation_lerp(&self, body: &[f32; BODY_LEN], index: f32) -> f32 {
        let base = floorf(index);
        let low = self.excitation_at(body, base);
        low + (self.excitation_at(body, base + 1.0) - low) * (index - base)
    }

    /// Renders additively and writes the pick excitation into `drive`; returns the chunk peak.
    pub fn render(&mut self, body: &[f32; BODY_LEN], out_l: &mut [f32], out_r: &mut [f32],
                  drive: &mut [f32]) -> f32 {
        let release_damp = if self.released {0.72} else {1.0};
        let mut peak = 0.0f32;
        for index in 0..out_l.len() {
            let mut input = 0.0f32;
            let mut heard = 0.0f32;
            if self.excitation_pos < BODY_LEN {
                // Both comb taps run through the same pick filter: brightness is tone only,
                // the pick-position comb (fixed depth) belongs to the Position knob.
                let raw = self.excitation_at(body, self.excitation_pos as f32);
                let delayed = self.excitation_at(body, self.excitation_pos as f32 - self.position_delay);
                self.pick_state += self.pick_lp * (raw - self.pick_state);
                self.pick_delayed += self.pick_lp * (delayed - self.pick_delayed);
                input = (self.pick_state - 0.55 * self.pick_delayed) * self.excitation_gain;
                heard = input;
                if self.body_lead != 0.0 {
                    // The twanging string reads the body at its bent pitch; object B hears the pick unbent.
                    let position = self.excitation_pos as f32 + self.body_lead;
                    let raw = self.excitation_lerp(body, position);
                    let delayed = self.excitation_lerp(body, position - self.position_delay);
                    self.bent_state += self.pick_lp * (raw - self.bent_state);
                    self.bent_delayed += self.pick_lp * (delayed - self.bent_delayed);
                    input = (self.bent_state - 0.55 * self.bent_delayed) * self.excitation_gain;
                    self.body_lead += self.twang;
                }
                self.excitation_pos += 1;
            }
            let mut scrape = 0.0f32;
            if self.scrape > 1.0e-6 {
                self.scrape_lp += self.scrape_color * (lcg(&mut self.noise_state) - self.scrape_lp);
                self.scrape_hp += 0.12 * (self.scrape_lp - self.scrape_hp);
                scrape = (self.scrape_lp - self.scrape_hp) * self.scrape;
                self.scrape *= self.scrape_decay;
                input += 0.5 * scrape;
                heard += 0.5 * scrape;
            }
            drive[index] = heard;
            self.age += 1.0 / self.sample_rate;
            let mut bend = 1.0f32;
            if self.age > 0.22 {
                self.vib_ramp = (self.vib_ramp + 1.8 / self.sample_rate).min(1.0);
            }
            self.vib_walk += 0.00004 * (lcg(&mut self.noise_state) - self.vib_walk);
            self.vib_phase += 5.4 * (1.0 + 20.0 * self.vib_walk) / self.sample_rate;
            if self.vib_phase >= 1.0 {
                self.vib_phase -= 1.0;
            }
            if self.vibrato_depth > 0.0 {
                bend = 1.0 - self.vibrato_depth * VIBRATO_RANGE * self.vib_ramp * self.vib_ramp
                    * sinf(2.0 * PI * self.vib_phase);
            }
            if self.twang > 0.0 {
                bend *= 1.0 - self.twang;
                self.twang = if self.twang > 1.0e-5 {self.twang * self.twang_decay} else {0.0};
            }
            let v = self.vertical.tick(input, release_damp, bend);
            let h = self.horizontal.tick(input * 0.6, release_damp, bend);
            let major = self.mix_major;
            let minor = 1.0 - major;
            let mut left = Self::dc_block(&mut self.dc_l, v * major + h * minor) * 1.85;
            let mut right = Self::dc_block(&mut self.dc_r, v * minor + h * major) * 1.85;
            if self.bite != 0.0 {
                left *= 1.0 + self.bite;
                right *= 1.0 + self.bite;
                self.bite = if fabsf(self.bite) > 1.0e-4 {self.bite * self.bite_decay} else {0.0};
            }
            left += 0.5 * scrape;
            right += 0.5 * scrape;
            out_l[index] += left;
            out_r[index] += right;
            peak = peak.max(fabsf(left)).max(fabsf(right));
        }
        peak
    }
}
