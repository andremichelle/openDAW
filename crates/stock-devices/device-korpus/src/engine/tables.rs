//! Material mode tables: standard acoustics ratios with per-mode amplitude and base T60 laws.
//! Shared by the driven bank and the bowed bank (Korpus 2 engine).

use libm::{powf, sqrtf};

pub const MAX_MODES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Material {
    Marimba,
    Vibraphone,
    Bell,
    Membrane,
    Plate,
    PianoWire,
}

impl Material {
    pub fn from_index(index: i32) -> Self {
        match index {
            1 => Self::Vibraphone,
            2 => Self::Bell,
            3 => Self::Membrane,
            4 => Self::Plate,
            5 => Self::PianoWire,
            _ => Self::Marimba,
        }
    }

    /// Near-harmonic materials grip and bow as a series, not a single band.
    pub fn harmonic_series(&self) -> bool {
        matches!(self, Self::PianoWire)
    }
}

const MARIMBA: [(f32, f32); 5] = [(1.0, 1.4), (4.0, 0.9), (9.2, 0.5), (16.4, 0.3), (25.4, 0.2)];
const VIBRAPHONE: [(f32, f32); 5] = [(1.0, 6.0), (4.0, 3.2), (10.0, 1.4), (18.4, 0.6), (25.8, 0.35)];
const BELL: [f32; 12] = [0.5, 1.0, 1.2, 1.5, 2.0, 2.61, 3.0, 3.36, 4.17, 5.43, 6.8, 8.2];
const MEMBRANE: [f32; 11] = [1.0, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501, 3.6, 4.06, 4.15];
const PLATE_COUNT: usize = 28;
const WIRE_COUNT: usize = 40;
const WIRE_B: f32 = 0.00045;

pub struct ModeSpec {
    pub ratio: f32,
    pub amp: f32,
    pub t60: f32,
}

pub fn spec(material: Material, index: usize) -> Option<ModeSpec> {
    match material {
        Material::Marimba => MARIMBA.get(index).map(|(ratio, t60)| ModeSpec {
            ratio: *ratio, amp: 1.0 / (1.0 + index as f32 * 0.7), t60: *t60}),
        Material::Vibraphone => VIBRAPHONE.get(index).map(|(ratio, t60)| ModeSpec {
            ratio: *ratio, amp: 1.0 / (1.0 + index as f32 * 0.9), t60: *t60}),
        Material::Bell => BELL.get(index).map(|ratio| ModeSpec {
            ratio: *ratio, amp: 1.0 / (1.0 + index as f32 * 0.5),
            t60: 9.0 * powf(0.78, index as f32) + 0.4}),
        Material::Membrane => MEMBRANE.get(index).map(|ratio| ModeSpec {
            ratio: *ratio, amp: 1.0 / (1.0 + index as f32 * 0.35),
            t60: 0.55 * powf(0.8, index as f32) + 0.05}),
        Material::Plate => (index < PLATE_COUNT).then(|| {
            let mut seed = 0x9e3779b9u32;
            for _ in 0..=index {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            }
            let jitter = 0.86 + 0.28 * (seed >> 8) as f32 / 16777216.0;
            let n = index as f32 + 1.0;
            ModeSpec {ratio: powf(n, 1.32) * jitter, amp: 1.0 / (1.0 + index as f32 * 0.25),
                t60: 2.6 * powf(0.88, index as f32) + 0.2}
        }),
        Material::PianoWire => (index < WIRE_COUNT).then(|| {
            let n = index as f32 + 1.0;
            ModeSpec {ratio: n * sqrtf(1.0 + WIRE_B * n * n), amp: 1.0 / n,
                t60: 5.2 * powf(0.9, index as f32) + 0.25}
        }),
    }
}
