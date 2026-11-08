//! The guitar bodies as impulse responses for commuted synthesis: each body is the sum of its modes (the
//! Helmholtz air mode, the top plate modes, the higher plate and back modes) plus a short burst of wood noise.
//! Every pluck reads it through the pick filter as its excitation, so the body sounds inside each note and
//! nothing rings on top of the strings. Off is no body at all, the bare original pluck. The electric bodies have
//! no acoustic body but a magnetic pickup: it hears the string at its position (a comb) and rolls off the highs
//! with a resonant peak, the signal an amp simulation expects.

use libm::{cosf, expf, powf, sinf};

const PI: f32 = core::f32::consts::PI;
const LENGTH_SECONDS: f32 = 0.1;
const FADE: f32 = 0.2;
const WOOD_TIME: f32 = 0.004;
const WOOD_LEVEL: f32 = 0.18;
const ENERGY: f32 = 0.002;
const AUDIBLE_FROM: f32 = 150.0;
pub const MAX_IR: usize = 19_200;

pub const BODY_NAMES: [&str; 8] = ["Off", "Dreadnought", "Classical", "Parlor", "Jumbo", "Archtop", "Electric Neck", "Electric Bridge"];
pub const BODY_COUNT: usize = BODY_NAMES.len();

// (frequency Hz, T60 seconds, amplitude) per mode, `wood` the level of its wood noise, `level` tames a peaky body,
// `brightness` the strings that go with the body (a classical has nylon, an archtop flatwounds), `bare` the pluck
// gain without a body, `pickup` the electric pickup (position on the string, resonance Hz, resonance Q), `stiffness`
// scales the inharmonicity of its strings (nylon is far less stiff than steel).
struct Preset {
    modes: &'static [(f32, f32, f32)],
    wood: f32,
    level: f32,
    brightness: f32,
    bare: f32,
    pickup: Option<(f32, f32, f32)>,
    stiffness: f32
}

const PRESETS: [Preset; BODY_COUNT] = [
    Preset {modes: &[], wood: 0.0, level: 1.0, brightness: 1.0, bare: 1.45, pickup: None, stiffness: 1.0},
    Preset {modes: &[(98.0, 0.26, 1.0), (185.0, 0.17, 0.8), (215.0, 0.14, 0.6), (390.0, 0.1, 0.45), (470.0, 0.08, 0.4),
        (560.0, 0.07, 0.3), (840.0, 0.05, 0.3), (1250.0, 0.04, 0.25), (2100.0, 0.03, 0.2), (3200.0, 0.02, 0.12)],
        wood: 0.78, level: 1.0, brightness: 1.0, bare: 1.0, pickup: None, stiffness: 1.0},
    Preset {modes: &[(95.0, 0.22, 0.7), (200.0, 0.2, 1.0), (258.0, 0.15, 0.6), (400.0, 0.11, 0.5), (540.0, 0.08, 0.35),
        (780.0, 0.06, 0.25), (1100.0, 0.04, 0.15)], wood: 0.85, level: 0.9, brightness: 0.62, bare: 1.0, pickup: None, stiffness: 0.3},
    Preset {modes: &[(125.0, 0.16, 0.4), (240.0, 0.14, 0.7), (300.0, 0.12, 0.6), (460.0, 0.09, 0.6), (650.0, 0.07, 0.55),
        (980.0, 0.05, 0.5), (1600.0, 0.04, 0.45), (2500.0, 0.03, 0.3)], wood: 0.7, level: 0.8, brightness: 1.25, bare: 1.0, pickup: None, stiffness: 1.0},
    Preset {modes: &[(88.0, 0.32, 1.2), (165.0, 0.2, 0.9), (205.0, 0.16, 0.7), (340.0, 0.11, 0.45), (450.0, 0.08, 0.35),
        (700.0, 0.06, 0.25), (1100.0, 0.04, 0.18), (1800.0, 0.03, 0.1)], wood: 0.82, level: 0.88, brightness: 0.95, bare: 1.0, pickup: None, stiffness: 1.1},
    Preset {modes: &[(110.0, 0.12, 0.3), (230.0, 0.12, 0.5), (350.0, 0.1, 0.9), (520.0, 0.08, 1.0), (800.0, 0.06, 0.8),
        (1300.0, 0.04, 0.45), (2000.0, 0.03, 0.2)], wood: 0.68, level: 0.72, brightness: 0.85, bare: 1.0, pickup: None, stiffness: 1.2},
    Preset {modes: &[], wood: 0.0, level: 1.0, brightness: 1.15, bare: 0.8, pickup: Some((0.25, 2500.0, 1.5)), stiffness: 0.9},
    Preset {modes: &[], wood: 0.0, level: 1.0, brightness: 1.15, bare: 1.15, pickup: Some((0.08, 4500.0, 2.2)), stiffness: 0.9}
];

pub struct Body {
    ir: [f32; MAX_IR],
    length: usize,
    index: usize,
    sample_rate: f32
}

impl Body {
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        self.index = usize::MAX;
        self.select(1);
    }

    pub fn select(&mut self, index: usize) {
        let index = index.min(BODY_COUNT - 1);
        if index == self.index {
            return;
        }
        self.index = index;
        let preset = &PRESETS[index];
        self.ir.fill(0.0);
        if preset.modes.is_empty() {
            self.length = 0;
            return;
        }
        let length = ((LENGTH_SECONDS * self.sample_rate) as usize).min(MAX_IR);
        let nyquist = self.sample_rate * 0.45;
        for &(frequency, t60, gain) in preset.modes {
            if frequency >= nyquist {
                continue;
            }
            let radius = powf(10.0, -3.0 / (t60 * self.sample_rate));
            let omega = 2.0 * PI * frequency / self.sample_rate;
            let coefficient = 2.0 * radius * cosf(omega);
            let amplitude = gain * sinf(omega);
            let (mut previous, mut before) = (0.0f32, 0.0f32);
            for (index, slot) in self.ir[..length].iter_mut().enumerate() {
                let input = if index == 0 {1.0} else {0.0};
                let output = coefficient * previous - radius * radius * before + input;
                before = previous;
                previous = output;
                *slot += output * amplitude;
            }
        }
        let peak = self.ir[..length].iter().fold(0.0f32, |peak, value| peak.max(value.abs())).max(1.0e-9);
        let wood = expf(-1.0 / (WOOD_TIME * self.sample_rate));
        let mut noise = 0x9e37_79b9u32 ^ index as u32;
        let (mut envelope, mut smooth) = (WOOD_LEVEL * preset.wood, 0.0f32);
        let fade_from = (length as f32 * (1.0 - FADE)) as usize;
        for (index, slot) in self.ir[..length].iter_mut().enumerate() {
            noise = noise.wrapping_mul(1664525).wrapping_add(1013904223);
            smooth += 0.5 * ((noise >> 8) as f32 / 8_388_608.0 - 1.0 - smooth);
            *slot = *slot / peak + smooth * envelope;
            envelope *= wood;
            if index >= fade_from {
                let fade = (length - index) as f32 / (length - fade_from) as f32;
                *slot *= fade * fade;
            }
        }
        self.length = length;
        self.normalize();
    }

    // Every body carries the same energy above the lowest strings, so a body changes the tone, not the level.
    fn normalize(&mut self) {
        let energy = self.audible_energy();
        let scale = libm::sqrtf(ENERGY / energy.max(1.0e-12)) * PRESETS[self.index].level;
        for slot in &mut self.ir[..self.length] {
            *slot *= scale;
        }
    }

    fn audible_energy(&self) -> f32 {
        let coefficient = expf(-2.0 * PI * AUDIBLE_FROM / self.sample_rate);
        let (mut previous_input, mut previous_output, mut energy) = (0.0f32, 0.0f32, 0.0f32);
        for value in &self.ir[..self.length] {
            let output = coefficient * (previous_output + value - previous_input);
            previous_input = *value;
            previous_output = output;
            energy += output * output;
        }
        energy / self.sample_rate
    }

    pub fn index(&self) -> usize {self.index}

    /// The loop brightness factor of the strings that go with this body.
    pub fn strings(&self) -> f32 {
        PRESETS[self.index.min(BODY_COUNT - 1)].brightness
    }

    /// The inharmonicity factor of the strings that go with this body.
    pub fn stiffness(&self) -> f32 {
        PRESETS[self.index.min(BODY_COUNT - 1)].stiffness
    }

    /// The bare string lacks the body's energy, its pluck is played louder to match the bodies.
    pub fn pluck_gain(&self) -> f32 {
        PRESETS[self.index.min(BODY_COUNT - 1)].bare
    }

    /// The electric pickup's position as a fraction of the string, None for the acoustic bodies.
    pub fn pickup(&self) -> Option<f32> {
        PRESETS[self.index.min(BODY_COUNT - 1)].pickup.map(|(position, _, _)| position)
    }

    /// The electric pickup's resonant lowpass as biquad coefficients (b0, b1, b2, a1, a2), None when acoustic.
    pub fn resonance(&self) -> Option<[f32; 5]> {
        let (_, frequency, quality) = PRESETS[self.index.min(BODY_COUNT - 1)].pickup?;
        let omega = 2.0 * PI * frequency.min(self.sample_rate * 0.45) / self.sample_rate;
        let alpha = sinf(omega) / (2.0 * quality);
        let cosine = cosf(omega);
        let norm = 1.0 + alpha;
        Some([(1.0 - cosine) * 0.5 / norm, (1.0 - cosine) / norm, (1.0 - cosine) * 0.5 / norm,
            -2.0 * cosine / norm, (1.0 - alpha) / norm])
    }

    /// The impulse response sample at `index`, silent past its end.
    #[inline]
    pub fn at(&self, index: usize) -> f32 {
        if index < self.length {self.ir[index]} else {0.0}
    }

    pub fn length(&self) -> usize {self.length}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(index: usize, rate: f32) -> Box<Body> {
        let mut body: Box<Body> = unsafe {Box::new_zeroed().assume_init()};
        body.init(rate);
        body.select(index);
        body
    }

    // The magnitude of the impulse response at `frequency`.
    fn magnitude(body: &Body, frequency: f32, rate: f32) -> f32 {
        let (mut real, mut imaginary) = (0.0f32, 0.0f32);
        for index in 0..body.length() {
            let phase = 2.0 * PI * frequency * index as f32 / rate;
            real += body.at(index) * phase.cos();
            imaginary += body.at(index) * phase.sin();
        }
        (real * real + imaginary * imaginary).sqrt()
    }

    #[test]
    fn off_is_no_body() {
        let off = body(0, 48_000.0);
        assert_eq!(off.length(), 0);
        assert_eq!(off.at(0), 0.0);
    }

    #[test]
    fn every_body_carries_the_same_energy() {
        for rate in [44_100.0f32, 48_000.0, 96_000.0] {
            for index in (1..BODY_COUNT).filter(|index| PRESETS[*index].pickup.is_none()) {
                let body = body(index, rate);
                let expected = ENERGY * PRESETS[index].level * PRESETS[index].level;
                assert!((body.audible_energy() / expected - 1.0).abs() < 1.0e-3, "{} at {rate}", BODY_NAMES[index]);
            }
        }
    }

    #[test]
    fn every_acoustic_body_resonates_at_its_air_mode() {
        for index in (1..BODY_COUNT).filter(|index| PRESETS[*index].pickup.is_none()) {
            let rate = 48_000.0;
            let first = PRESETS[index].modes[0].0;
            let body = body(index, rate);
            let peak = magnitude(&body, first, rate);
            let between = magnitude(&body, first * 0.62, rate);
            assert!(peak > between * 1.5, "{}: {peak} vs {between}", BODY_NAMES[index]);
        }
    }

    #[test]
    fn ends_silent_and_stays_bounded_at_every_rate() {
        for index in 0..BODY_COUNT {
            for rate in [22_050.0f32, 44_100.0, 48_000.0, 96_000.0, 192_000.0] {
                let body = body(index, rate);
                assert!((0..body.length()).all(|sample| body.at(sample).is_finite()));
                assert!(body.length() <= MAX_IR);
                if body.length() > 0 {
                    assert!(body.at(body.length() - 1).abs() < 1.0e-3);
                }
            }
        }
    }
}
