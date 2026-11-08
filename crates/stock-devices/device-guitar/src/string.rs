//! One guitar string, a Karplus-Strong string with the established extensions. The pluck is the string's
//! velocity when it leaves the pick: displaced into a triangle at the Spot and let go, its corner rounded by the
//! width of the finger, thumb, nail or plectrum, roughened by the original noise table blended with fresh noise
//! (every pick a little different), smoothed by the plug filter. A hard pluck starts a few cents sharp (tension
//! modulation), a pick stops a ringing string before it plucks it, and the pick angle sets how the two slightly
//! detuned polarizations ring: the vertical one gives its energy to the body and fades fast on high notes, the
//! horizontal one sustains. A dynamic-level lowpass makes soft picks darker, the body's impulse response joins
//! the pluck (commuted synthesis). The loop lowpass fades the overtones at a rate per second measured on a steel
//! string acoustic, a chain of allpasses makes the string stiff (its overtones run sharp, measured too), an
//! allpass fractional delay corrected by the loop's phase delay keeps every fret in tune. Tension shortens the
//! string. An electric body's pickup hears the string at its position, a comb on the output.

use libm::{atan2f, cosf, expf, floorf, powf, sinf, sqrtf};

use crate::body::Body;

pub const MAX_DELAY: usize = 4096;
const PI: f32 = core::f32::consts::PI;
const DETUNE: f32 = 1.0007;
const HORIZONTAL_DARKER: f32 = 0.85;
const HORIZONTAL_MIX: f32 = 0.35;
const TWANG_TIME: f32 = 0.04;
const DISPERSION_STAGES: usize = 4;
const STIFFNESS_LOW_E: f32 = 2.3e-5;
const STIFFNESS_SLOPE: f32 = 0.63;
const OVERTONE_FREQUENCY: f32 = 3000.0;
const BODY_DECAY: f32 = 16.0;
const BODY_DECAY_LIMIT: f32 = 40.0;
const UP_BRIGHTER: f32 = 1.15;
const EQUAL_PLUCK: f32 = 0.75;
const EQUAL_LIMIT: f32 = 2.5;
const REFERENCE_PITCH: f32 = 57.0;
const PLUCK_GAIN: f32 = 0.3;
const BODY_MIX: f32 = 0.3;
const TENSION_SHORTENING: f32 = 0.5;
const RING_T60: f32 = 30.0;
const RELEASE_T60: f32 = 0.08;
const PALM_T60: f32 = 0.16;
const CHUCK_T60: f32 = 0.025;
const PALM_DULL: f32 = 0.45;
const PALM_GAIN: f32 = 2.0;
const CHUCK_GAIN: f32 = 8.0;
const CHUCK_PLUG: f32 = 0.9;
const CHUCK_DULL: f32 = 0.3;
const GAIN_FOLLOW_TIME: f32 = 0.002;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Touch {
    Open,
    Palm,
    Chuck
}

// WASM CONTRACT: the order mirrors `GuitarDeviceBoxAdapter.Picks` (pick field 37)
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Pick {
    Finger,
    Thumb,
    Nail,
    Plectrum
}

impl Pick {
    pub fn from_index(index: i32) -> Pick {
        match index {
            0 => Pick::Finger,
            1 => Pick::Thumb,
            2 => Pick::Nail,
            _ => Pick::Plectrum
        }
    }
}

// How a pick touches the string. `width` is the contact as a fraction of the string, `soften` scales the plug
// filter, `roughness` the surface noise, `stop` what is left of a ringing string it touches, `twang` the start
// sharpness in cents at full velocity, `drive` the horizontal polarization (the pick angle).
struct Contact {
    width: f32,
    soften: f32,
    roughness: f32,
    stop: f32,
    twang: f32,
    drive: f32,
    gain: f32
}

const CONTACTS: [Contact; 4] = [
    Contact {width: 0.02, soften: 0.55, roughness: 0.15, stop: 0.2, twang: 4.0, drive: 0.75, gain: 1.15},
    Contact {width: 0.035, soften: 0.4, roughness: 0.1, stop: 0.15, twang: 5.0, drive: 0.5, gain: 1.3},
    Contact {width: 0.006, soften: 0.85, roughness: 0.25, stop: 0.3, twang: 6.0, drive: 0.65, gain: 1.0},
    Contact {width: 0.002, soften: 1.0, roughness: 0.3, stop: 0.35, twang: 8.0, drive: 0.5, gain: 1.0}
];

/// Everything a pluck needs, resolved by the device (the variations already applied).
#[derive(Clone, Copy, Debug)]
pub struct Pluck {
    pub pitch: f32,
    pub velocity: f32,
    /// How fast the overtones fade, in dB per second at 3 kHz.
    pub decay: f32,
    /// The plug filter coefficient (the original `plugDamp`), higher is a brighter pick.
    pub plug: f32,
    /// The spot the pick hits as a fraction of the string (0.13 is typical).
    pub position: f32,
    /// 0 is the fretted string, 1 shortens it to sound an octave higher.
    pub tension: f32,
    /// The chaos of the pick: fresh noise replaces the fixed table and the contact varies, 0 plays identical picks.
    pub character: f32,
    pub touch: Touch,
    pub pick: Pick,
    pub up: bool,
    pub noise_seed: u32
}

#[inline]
fn lcg(state: &mut u32) -> f32 {
    *state = state.wrapping_mul(1664525).wrapping_add(1013904223);
    (*state >> 8) as f32 / 8388608.0 - 1.0
}

/// The phase delay in samples of the first-order allpass `(a + z^-1) / (1 + a z^-1)` at `omega`.
#[inline]
fn allpass_delay(coefficient: f32, omega: f32) -> f32 {
    let (s, c) = (sinf(omega), cosf(omega));
    -(atan2f(-s, coefficient + c) - atan2f(-coefficient * s, 1.0 + coefficient * c)) / omega
}

/// The phase delay in samples of the one-pole lowpass `y += c (x - y)` at `omega`.
#[inline]
fn one_pole_delay(coefficient: f32, omega: f32) -> f32 {
    let keep = 1.0 - coefficient;
    atan2f(keep * sinf(omega), 1.0 - keep * cosf(omega)) / omega
}

/// The overtone decay in dB per second at 3 kHz for Damping (0 to 1), 0.33 matches a steel string acoustic.
/// The wound strings lose their overtones faster than the plain ones.
pub fn overtone_decay(damping: f32, pitch: f32) -> f32 {
    let wound = 1.0 + 1.2 * ((64.0 - pitch) / 24.0).clamp(0.0, 1.0);
    8.0 * powf(100.0, damping.clamp(0.0, 1.0)) * wound
}

// The loop lowpass coefficient that fades 3 kHz by `decay` dB per second at `frequency`.
fn loop_lowpass(decay: f32, frequency: f32, sample_rate: f32) -> f32 {
    let omega = 2.0 * PI * OVERTONE_FREQUENCY.min(0.45 * sample_rate) / sample_rate;
    let magnitude = powf(10.0, -decay / (20.0 * frequency));
    let squared = magnitude * magnitude;
    if squared > 0.999_999 {
        return 1.0;
    }
    let half = 1.0 - squared * cosf(omega);
    let keep = (half - sqrtf((half * half - (1.0 - squared) * (1.0 - squared)).max(0.0))) / (1.0 - squared);
    (1.0 - keep).clamp(0.02, 1.0)
}

// The allpass coefficient that makes partial n run sharp like a string with inharmonicity `stiffness` (B).
fn dispersion(stiffness: f32, frequency: f32, sample_rate: f32) -> f32 {
    let period = sample_rate / frequency;
    let partial = floorf((4000.0 / frequency).min(0.4 * sample_rate / frequency)).min(30.0);
    if stiffness <= 0.0 || partial < 2.0 {
        return 0.0;
    }
    let stretch = sqrtf(1.0 + stiffness * partial * partial);
    let wanted = period * (1.0 - 1.0 / stretch);
    let (low, high) = (2.0 * PI * frequency / sample_rate, 2.0 * PI * frequency * partial * stretch / sample_rate);
    let stages = DISPERSION_STAGES as f32;
    let budget = period - 6.0;
    let (mut lower, mut upper) = (-0.95f32, 0.0f32);
    for _ in 0..24 {
        let middle = 0.5 * (lower + upper);
        let spread = stages * (allpass_delay(middle, low) - allpass_delay(middle, high));
        if spread > wanted || stages * allpass_delay(middle, low) > budget {
            lower = middle;
        } else {
            upper = middle;
        }
    }
    upper
}

struct Loop {
    line: [f32; MAX_DELAY],
    write: usize,
    delay: f32,
    target: f32,
    applied: f32,
    integer: usize,
    eta: f32,
    ap_in: f32,
    ap_out: f32,
    damp_coefficient: f32,
    damp_state: f32,
    gain: f32,
    gain_target: f32,
    frequency: f32,
    bend: f32,
    bend_decay: f32,
    dispersion: f32,
    dispersion_state: [(f32, f32); DISPERSION_STAGES],
    mute_samples: usize,
    mute_gain: f32
}

impl Loop {
    fn clear(&mut self) {
        self.line.fill(0.0);
        self.write = 0;
        self.ap_in = 0.0;
        self.ap_out = 0.0;
        self.damp_state = 0.0;
        self.gain = 0.0;
        self.gain_target = 0.0;
        self.bend = 0.0;
        self.dispersion_state = [(0.0, 0.0); DISPERSION_STAGES];
        self.mute_samples = 0;
    }

    fn set_delay(&mut self, delay: f32) {
        let clamped = delay.clamp(2.0, (MAX_DELAY - 4) as f32);
        let integer = (clamped - 0.1) as usize;
        let fraction = clamped - integer as f32;
        self.applied = clamped;
        self.integer = integer;
        self.eta = (1.0 - fraction) / (1.0 + fraction);
    }

    // The line length for `frequency`: the line plus the fractional allpass plus the lowpass add up to one period.
    fn tuned_delay(&mut self, frequency: f32, sample_rate: f32) -> f32 {
        let omega = (2.0 * PI * frequency / sample_rate).max(1.0e-4);
        let target = sample_rate / frequency - one_pole_delay(self.damp_coefficient, omega)
            - DISPERSION_STAGES as f32 * allpass_delay(self.dispersion, omega);
        let mut delay = target;
        for _ in 0..3 {
            self.set_delay(delay);
            let actual = self.integer as f32 + allpass_delay(self.eta, omega);
            delay += target - actual;
        }
        delay.clamp(2.0, (MAX_DELAY - 4) as f32)
    }

    // A silent loop jumps to the new length, a sounding one glides there (a new fret under a ringing string).
    fn tune(&mut self, frequency: f32, sample_rate: f32, glide: bool) {
        self.frequency = frequency;
        self.target = self.tuned_delay(frequency, sample_rate);
        if !glide {
            self.delay = self.target;
        }
        self.set_delay(self.delay);
    }

    fn loop_gain(&self, t60: f32) -> f32 {
        powf(10.0, -3.0 / (self.frequency * t60))
    }

    #[inline]
    fn tick(&mut self, input: f32, follow: f32) -> f32 {
        let target = if self.mute_samples > 0 {
            self.mute_samples -= 1;
            self.gain_target * self.mute_gain
        } else {
            self.gain_target
        };
        self.gain += (target - self.gain) * follow;
        if self.delay != self.target {
            self.delay = if (self.target - self.delay).abs() < 1.0e-4 {self.target} else {self.delay + (self.target - self.delay) * follow};
        }
        if self.bend != 0.0 {
            self.bend = if self.bend < 1.0e-7 {0.0} else {self.bend * self.bend_decay};
        }
        let wanted = self.delay * (1.0 - self.bend);
        if wanted != self.applied {
            self.set_delay(wanted);
        }
        let first = self.line[(self.write + MAX_DELAY - self.integer) % MAX_DELAY];
        let read = self.eta * first + self.ap_in - self.eta * self.ap_out;
        self.ap_in = first;
        self.ap_out = read;
        let mut stiff = read;
        for state in &mut self.dispersion_state {
            let output = self.dispersion * stiff + state.0 - self.dispersion * state.1;
            *state = (stiff, output);
            stiff = output;
        }
        self.damp_state += self.damp_coefficient * (stiff - self.damp_state);
        let signal = self.damp_state * self.gain;
        self.line[self.write] = signal + input;
        self.write = (self.write + 1) % MAX_DELAY;
        signal
    }
}

pub struct GuitarString {
    vertical: Loop,
    horizontal: Loop,
    burst: [f32; MAX_DELAY],
    burst_length: usize,
    drive: f32,
    history: [f32; MAX_DELAY],
    history_write: usize,
    pickup: usize,
    position: usize,
    length: usize,
    comb: usize,
    gain: f32,
    level: f32,
    level_state: f32,
    follow: f32,
    pitch: f32,
    sounding: bool,
    released: bool,
    sample_rate: f32
}

impl GuitarString {
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        self.follow = 1.0 - expf(-1.0 / (GAIN_FOLLOW_TIME * sample_rate));
        self.reset();
    }

    pub fn reset(&mut self) {
        self.vertical.clear();
        self.horizontal.clear();
        self.history.fill(0.0);
        self.history_write = 0;
        self.burst_length = 0;
        self.position = 0;
        self.length = 0;
        self.pitch = -1.0;
        self.sounding = false;
        self.released = false;
    }

    pub fn pitch(&self) -> f32 {self.pitch}

    pub fn is_sounding(&self) -> bool {self.sounding}

    pub fn pluck(&mut self, pluck: &Pluck, body: &Body, character: &[f32; MAX_DELAY], base_frequency: f32) {
        let sample_rate = self.sample_rate;
        let fretted = base_frequency * powf(2.0, (pluck.pitch - 69.0) / 12.0);
        let frequency = fretted / (1.0 - TENSION_SHORTENING * pluck.tension.clamp(0.0, 1.0));
        let ringing = self.sounding;
        if !ringing {
            self.vertical.clear();
            self.horizontal.clear();
        }
        let body_decay = (1.0 + BODY_DECAY * (frequency / 330.0) * (frequency / 330.0)).min(BODY_DECAY_LIMIT);
        let (vertical_t60, horizontal_t60, dull) = match pluck.touch {
            Touch::Open => (60.0 / body_decay, RING_T60, 1.0),
            Touch::Palm => (PALM_T60, PALM_T60, PALM_DULL),
            Touch::Chuck => (CHUCK_T60, CHUCK_T60, CHUCK_DULL)
        };
        let contact = &CONTACTS[pluck.pick as usize];
        let chuck = pluck.touch == Touch::Chuck;
        let mut chaos_state = pluck.noise_seed.wrapping_mul(2654435761) | 1;
        let mut chaos = || lcg(&mut chaos_state) * pluck.character.clamp(0.0, 1.0);
        let velocity = pluck.velocity.min(1.0);
        let twang = if chuck {0.0} else {contact.twang * velocity * velocity * (1.0 + 0.4 * chaos())};
        let bend = 1.0 - powf(2.0, -twang / 1200.0);
        let bend_decay = expf(-1.0 / (TWANG_TIME * sample_rate));
        let coefficient = (loop_lowpass(pluck.decay, frequency, sample_rate) * dull).clamp(0.02, 1.0);
        let stiffness = STIFFNESS_LOW_E * powf(frequency / 82.4, STIFFNESS_SLOPE) * body.stiffness();
        let stop = if ringing && !chuck {contact.stop} else {1.0};
        let period_samples = (sample_rate / frequency) as usize;
        for (polarization, detune, darker, t60) in [(&mut self.vertical, 1.0, 1.0, vertical_t60),
            (&mut self.horizontal, DETUNE, HORIZONTAL_DARKER, horizontal_t60)] {
            polarization.damp_coefficient = coefficient * darker;
            polarization.dispersion = dispersion(stiffness, frequency * detune, sample_rate);
            polarization.tune(frequency * detune, sample_rate, ringing);
            polarization.bend = bend;
            polarization.bend_decay = bend_decay;
            polarization.mute_samples = if stop < 1.0 {period_samples} else {0};
            polarization.mute_gain = stop;
            let gain = polarization.loop_gain(t60);
            polarization.gain_target = gain;
            if !ringing {
                polarization.gain = gain;
            }
        }
        self.drive = (contact.drive * (1.0 + 0.6 * chaos())).clamp(0.0, 1.0);
        let period = ((sample_rate / frequency) as usize).clamp(2, MAX_DELAY - 1);
        let spot = pluck.position.clamp(0.02, 0.5);
        let corner = spot * period as f32;
        let width = (contact.width * (1.0 + 0.5 * chaos()) * period as f32).max(1.0);
        let mut noise = pluck.noise_seed | 1;
        let (mut smooth, mut mean) = (0.0f32, 0.0f32);
        let (fresh, plug) = if chuck {(1.0, CHUCK_PLUG)} else {
            let up = if pluck.up {UP_BRIGHTER} else {1.0};
            (pluck.character, (pluck.plug * contact.soften * up * (1.0 + 0.2 * chaos())).clamp(0.02, 0.95))
        };
        for index in 0..period {
            let rough = character[index] * (1.0 - fresh) + lcg(&mut noise) * fresh;
            let raw = if chuck {rough} else {
                let ramp = ((index as f32 + 0.5 - corner) / width + 0.5).clamp(0.0, 1.0);
                1.0 - spot - ramp + rough * contact.roughness
            };
            smooth += (raw - smooth) * plug;
            self.burst[index] = smooth;
            mean += smooth;
        }
        mean /= period as f32;
        for value in &mut self.burst[..period] {
            *value -= mean;
        }
        self.burst_length = period;
        self.pickup = body.pickup().map_or(0, |position| ((position * period as f32) as usize).max(1));
        self.comb = ((spot * period as f32) as usize).max(1);
        self.length = body.length().max(period) + self.comb;
        self.position = 0;
        let touch_gain = match pluck.touch {
            Touch::Open => 1.0,
            Touch::Palm => PALM_GAIN,
            Touch::Chuck => CHUCK_GAIN
        };
        let reference = sample_rate / (base_frequency * powf(2.0, (REFERENCE_PITCH - 69.0) / 12.0));
        let equal = powf(reference / period as f32, EQUAL_PLUCK).min(EQUAL_LIMIT);
        let contact_gain = if chuck {1.0} else {contact.gain};
        self.gain = pluck.velocity * PLUCK_GAIN * body.pluck_gain() * touch_gain * contact_gain * equal;
        self.level = 0.2 + 0.8 * pluck.velocity.min(1.0);
        self.level_state = 0.0;
        self.pitch = pluck.pitch;
        self.sounding = true;
        self.released = false;
    }

    /// Lifts the finger: the loop gain falls to a short decay, the string fades out without a click.
    pub fn release(&mut self) {
        if !self.sounding || self.released {
            return;
        }
        self.released = true;
        for polarization in [&mut self.vertical, &mut self.horizontal] {
            polarization.gain_target = polarization.loop_gain(RELEASE_T60);
        }
    }

    // The pluck stream at `index`: the burst (its shape holds the spot) plus the body through the spot's comb.
    #[inline]
    fn excitation(&self, index: usize, body: &Body) -> f32 {
        let burst = if index < self.burst_length {self.burst[index]} else {0.0};
        let delayed = if index >= self.comb {body.at(index - self.comb)} else {0.0};
        burst + (body.at(index) - delayed) * BODY_MIX
    }

    /// Renders additively into the mono `out`. Returns false once the string fell silent.
    pub fn render(&mut self, out: &mut [f32], body: &Body) -> bool {
        if !self.sounding {
            return false;
        }
        let mut energy = 0.0f32;
        for sample in out.iter_mut() {
            let input = if self.position < self.length {
                let raw = self.excitation(self.position, body);
                self.position += 1;
                self.level_state += self.level * (raw - self.level_state);
                self.level_state * self.gain
            } else {
                0.0
            };
            let vertical = self.vertical.tick(input, self.follow);
            let horizontal = self.horizontal.tick(input * self.drive, self.follow);
            let mut value = vertical + HORIZONTAL_MIX * horizontal;
            if self.pickup > 0 {
                self.history[self.history_write] = value;
                value -= self.history[(self.history_write + MAX_DELAY - self.pickup) % MAX_DELAY];
                self.history_write = (self.history_write + 1) % MAX_DELAY;
            }
            energy += value * value;
            *sample += value;
        }
        if self.position >= self.length && energy < 1.0e-12 * out.len().max(1) as f32 {
            self.reset();
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn boxed_string() -> Box<GuitarString> {
        let mut string: Box<GuitarString> = unsafe {Box::new_zeroed().assume_init()};
        string.init(RATE);
        string
    }

    fn body(index: usize) -> Box<Body> {
        let mut body: Box<Body> = unsafe {Box::new_zeroed().assume_init()};
        body.init(RATE);
        body.select(index);
        body
    }

    fn character() -> Box<[f32; MAX_DELAY]> {
        let mut table = Box::new([0.0f32; MAX_DELAY]);
        let mut state = 65535u32;
        for value in table.iter_mut() {
            *value = lcg(&mut state);
        }
        table
    }

    fn pluck(pitch: f32) -> Pluck {
        Pluck {pitch, velocity: 0.8, decay: overtone_decay(0.33, pitch), plug: 0.5, position: 0.13,
            tension: 0.0, character: 0.5, touch: Touch::Open, pick: Pick::Plectrum, up: false, noise_seed: 7}
    }

    fn render(string: &mut GuitarString, seconds: f32, body: &Body) -> Vec<f32> {
        let mut out = vec![0.0f32; (seconds * RATE) as usize];
        for chunk in out.chunks_mut(128) {
            string.render(chunk, body);
        }
        out
    }

    // The fundamental's own frequency: a Hann windowed spectrum scanned finely around the expected pitch.
    fn measured_frequency(signal: &[f32], expected: f32) -> f32 {
        let window = &signal[(0.25 * RATE) as usize..(0.75 * RATE) as usize];
        let length = window.len() as f32;
        let magnitude = |frequency: f32| -> f32 {
            let (mut real, mut imaginary) = (0.0f64, 0.0f64);
            for (index, value) in window.iter().enumerate() {
                let hann = 0.5 - 0.5 * (2.0 * PI * index as f32 / length).cos();
                let phase = 2.0 * std::f64::consts::PI * frequency as f64 * index as f64 / RATE as f64;
                real += (value * hann) as f64 * phase.cos();
                imaginary += (value * hann) as f64 * phase.sin();
            }
            (real * real + imaginary * imaginary) as f32
        };
        let (mut best, mut best_value) = (expected, 0.0f32);
        let mut frequency = expected * 0.98;
        while frequency < expected * 1.02 {
            let value = magnitude(frequency);
            if value > best_value {
                best = frequency;
                best_value = value;
            }
            frequency += expected * 0.0002;
        }
        best
    }

    fn cents(measured: f32, expected: f32) -> f32 {
        1200.0 * (measured / expected).log2()
    }

    fn rms(signal: &[f32]) -> f32 {
        (signal.iter().map(|value| value * value).sum::<f32>() / signal.len() as f32).sqrt()
    }

    fn hertz(pitch: f32) -> f32 {
        440.0 * 2.0f32.powf((pitch - 69.0) / 12.0)
    }

    #[test]
    fn every_fret_is_in_tune() {
        let (table, body) = (character(), body(1));
        for pitch in [40.0f32, 45.0, 52.0, 59.0, 64.0, 71.0, 76.0, 83.0, 88.0] {
            let mut string = boxed_string();
            string.pluck(&pluck(pitch), &body, &table, 440.0);
            let signal = render(&mut string, 0.8, &body);
            let error = cents(measured_frequency(&signal, hertz(pitch)), hertz(pitch));
            assert!(error.abs() < 2.0, "pitch {pitch}: {error:.2} cents");
        }
    }

    #[test]
    fn tension_shortens_the_string_up_to_an_octave() {
        let (table, body) = (character(), body(1));
        for (tension, expected) in [(0.5f32, hertz(52.0) / 0.75), (1.0, hertz(64.0))] {
            let mut string = boxed_string();
            string.pluck(&Pluck {tension, ..pluck(52.0)}, &body, &table, 440.0);
            let signal = render(&mut string, 0.8, &body);
            let error = cents(measured_frequency(&signal, expected), expected);
            assert!(error.abs() < 2.0, "tension {tension}: {error:.2} cents");
        }
    }

    #[test]
    fn every_pick_sounds_a_little_different_unless_the_character_is_fixed() {
        let (table, body) = (character(), body(0));
        let attack = |seed: u32, character: f32| -> Vec<f32> {
            let mut string = boxed_string();
            string.pluck(&Pluck {noise_seed: seed, character, ..pluck(52.0)}, &body, &table, 440.0);
            render(&mut string, 0.02, &body)
        };
        let difference = |left: &[f32], right: &[f32]| rms(&left.iter().zip(right).map(|(a, b)| a - b).collect::<Vec<_>>());
        assert_eq!(difference(&attack(1, 0.0), &attack(2, 0.0)), 0.0);
        assert!(difference(&attack(1, 0.5), &attack(2, 0.5)) > 0.1 * rms(&attack(1, 0.5)));
    }

    fn attack_brightness(pick: Pick, up: bool) -> f32 {
        let (table, body) = (character(), body(0));
        let mut string = boxed_string();
        string.pluck(&Pluck {pick, up, character: 0.0, ..pluck(52.0)}, &body, &table, 440.0);
        let signal = render(&mut string, 0.05, &body);
        rms(&signal.windows(2).map(|pair| pair[1] - pair[0]).collect::<Vec<_>>()) / rms(&signal)
    }

    #[test]
    fn the_picks_go_from_a_soft_thumb_to_a_bright_plectrum() {
        let picks = [Pick::Thumb, Pick::Finger, Pick::Nail, Pick::Plectrum].map(|pick| attack_brightness(pick, false));
        assert!(picks.windows(2).all(|pair| pair[0] < pair[1] * 0.9), "{picks:?}");
        assert!(attack_brightness(Pick::Plectrum, true) > picks[3], "an upstroke is brighter");
    }

    #[test]
    fn a_hard_pluck_starts_sharp_and_settles() {
        let (table, body) = (character(), body(0));
        let mut string = boxed_string();
        string.pluck(&Pluck {velocity: 1.0, ..pluck(52.0)}, &body, &table, 440.0);
        render(&mut string, 0.002, &body);
        let early = string.vertical.target / string.vertical.applied;
        render(&mut string, 0.5, &body);
        let late = string.vertical.target / string.vertical.applied;
        assert!(cents(early, 1.0) > 4.0, "{:.2} cents sharp at the start", cents(early, 1.0));
        assert!(cents(late, 1.0).abs() < 0.05);
    }

    // Measured on a steel string acoustic: the 10th partial of the high e runs about 6 cents sharp.
    #[test]
    fn the_overtones_run_sharp_like_a_steel_string() {
        let table = character();
        let sharpness = |body: &Body| -> f32 {
            let mut string = boxed_string();
            string.pluck(&pluck(64.0), body, &table, 440.0);
            let signal = render(&mut string, 0.8, body);
            let fundamental = measured_frequency(&signal, hertz(64.0));
            cents(measured_frequency(&signal, fundamental * 10.0), fundamental * 10.0)
        };
        let (steel, nylon) = (sharpness(&body(1)), sharpness(&body(2)));
        assert!(steel > 2.0 && steel < 10.0, "steel {steel:.2} cents");
        assert!(nylon < steel * 0.5, "nylon {nylon:.2} cents");
    }

    #[test]
    fn a_pick_stops_the_ringing_string_before_it_plucks() {
        let (table, body) = (character(), body(0));
        let tail = |restrike: bool| -> f32 {
            let mut string = boxed_string();
            string.pluck(&pluck(45.0), &body, &table, 440.0);
            render(&mut string, 0.3, &body);
            if restrike {
                string.pluck(&Pluck {velocity: 0.02, ..pluck(45.0)}, &body, &table, 440.0);
            }
            rms(&render(&mut string, 0.2, &body)[(0.1 * RATE) as usize..])
        };
        assert!(tail(true) < tail(false) * 0.5);
    }

    #[test]
    fn a_soft_pick_is_darker() {
        let (table, body) = (character(), body(0));
        let brightness = |velocity: f32| -> f32 {
            let mut string = boxed_string();
            string.pluck(&Pluck {velocity, ..pluck(45.0)}, &body, &table, 440.0);
            let signal = render(&mut string, 0.1, &body);
            let slope = rms(&signal.windows(2).map(|pair| pair[1] - pair[0]).collect::<Vec<_>>());
            slope / rms(&signal)
        };
        assert!(brightness(0.2) < brightness(1.0) * 0.8);
    }

    #[test]
    fn higher_notes_decay_faster_like_the_original() {
        let (table, body) = (character(), body(0));
        let decay = |pitch: f32| -> f32 {
            let mut string = boxed_string();
            string.pluck(&pluck(pitch), &body, &table, 440.0);
            let signal = render(&mut string, 1.2, &body);
            rms(&signal[(1.0 * RATE) as usize..]) / rms(&signal[(0.1 * RATE) as usize..(0.3 * RATE) as usize])
        };
        assert!(decay(76.0) < decay(45.0));
    }

    #[test]
    fn a_released_string_falls_silent_quickly() {
        let (table, body) = (character(), body(1));
        let mut string = boxed_string();
        string.pluck(&pluck(52.0), &body, &table, 440.0);
        render(&mut string, 0.2, &body);
        string.release();
        let signal = render(&mut string, 0.4, &body);
        assert!(rms(&signal[(0.3 * RATE) as usize..]) < 1.0e-4);
    }

    #[test]
    fn palm_mute_is_short() {
        let (table, body) = (character(), body(1));
        let mut open = boxed_string();
        let mut palm = boxed_string();
        open.pluck(&pluck(52.0), &body, &table, 440.0);
        palm.pluck(&Pluck {touch: Touch::Palm, ..pluck(52.0)}, &body, &table, 440.0);
        let (open, palm) = (render(&mut open, 0.5, &body), render(&mut palm, 0.5, &body));
        let tail = (0.35 * RATE) as usize..(0.45 * RATE) as usize;
        assert!(rms(&palm[tail.clone()]) < rms(&open[tail]) * 0.05);
    }

    #[test]
    fn a_restrike_adds_to_the_ringing_string() {
        let (table, body) = (character(), body(1));
        let mut string = boxed_string();
        string.pluck(&pluck(57.0), &body, &table, 440.0);
        let before = render(&mut string, 0.3, &body);
        string.pluck(&pluck(57.0), &body, &table, 440.0);
        let after = render(&mut string, 0.01, &body);
        assert!((after[0] - before[before.len() - 1]).abs() < 0.05, "no jump at the restrike");
    }

    #[test]
    fn stays_finite_at_the_extremes() {
        let table = character();
        for (pitch, damping, tension) in [(38.0f32, 1.0f32, 1.0f32), (100.0, 0.0, 1.0), (38.0, 0.0, 0.0), (100.0, 1.0, 0.0)] {
            for rate in [44_100.0f32, 192_000.0] {
                let mut body: Box<Body> = unsafe {Box::new_zeroed().assume_init()};
                body.init(rate);
                let mut string: Box<GuitarString> = unsafe {Box::new_zeroed().assume_init()};
                string.init(rate);
                let decay = overtone_decay(damping, pitch);
                string.pluck(&Pluck {pitch, tension, velocity: 1.0, decay, plug: 0.9, ..pluck(pitch)}, &body, &table, 440.0);
                let mut out = vec![0.0f32; 48_000];
                string.render(&mut out, &body);
                assert!(out.iter().all(|value| value.is_finite() && value.abs() < 4.0), "pitch {pitch} rate {rate}");
            }
        }
    }
}
