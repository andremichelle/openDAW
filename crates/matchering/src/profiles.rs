// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

//! Built-in reference profiles, designed rather than measured: each is a spectral shape and a loudness. The shape is
//! imprinted on deterministic noise, which then runs through the regular reference analysis, so a built-in profile
//! is exactly what analysing an audio file with that spectrum would give.

use crate::analysis::{analyse_reference, ReferenceProfile};
use crate::config::SAMPLE_RATE;
use crate::fft::Fft;

const LENGTH: usize = 1 << 20;

struct Design {
    tilt: f64,
    bumps: &'static [(f64, f64, f64)],
    side_low: f64,
    side_high: f64,
    rms: f64
}

// WASM CONTRACT: the order matches `Matchering.BuiltinProfiles` in packages/studio/matchering/src/Matchering.ts.
const DESIGNS: [Design; 4] = [
    Design {tilt: -4.5, bumps: &[], side_low: -14.0, side_high: -7.0, rms: -11.0},
    Design {tilt: -5.5, bumps: &[(120.0, 2.0, 1.5), (9000.0, -2.0, 1.5)], side_low: -15.0, side_high: -8.0, rms: -11.0},
    Design {tilt: -3.5, bumps: &[(8000.0, 2.0, 1.5)], side_low: -14.0, side_high: -6.0, rms: -11.0},
    Design {tilt: -4.5, bumps: &[(70.0, 3.0, 0.8), (3000.0, 1.5, 1.2)], side_low: -16.0, side_high: -7.0, rms: -9.0}
];

pub const COUNT: usize = DESIGNS.len();

impl Design {
    fn mid_db(&self, frequency: f64) -> f64 {
        let octaves = (frequency / 1000.0).log2();
        let low_cut = -10.0 * (1.0 + (30.0 / frequency).powi(4)).log10();
        let high_cut = -10.0 * (1.0 + (frequency / 16000.0).powi(8)).log10();
        let bumps: f64 = self.bumps.iter()
            .map(|(center, gain, width)| gain * (-((frequency / center).log2() / width).powi(2)).exp()).sum();
        self.tilt * octaves + low_cut + high_cut + bumps
    }

    fn side_db(&self, frequency: f64) -> f64 {
        let position = ((frequency / 200.0).log2() / 10f64.log2()).clamp(0.0, 1.0);
        self.mid_db(frequency) + self.side_low + (self.side_high - self.side_low) * position
    }
}

fn noise(seed: u64, index: u64) -> f64 {
    let mut z = seed.wrapping_add(index.wrapping_mul(0x9E3779B97F4A7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^= z >> 31;
    (z >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
}

fn shaped(fft: &Fft, seed: u64, decibels: impl Fn(f64) -> f64) -> Vec<f64> {
    let mut re: Vec<f64> = (0..LENGTH).map(|index| noise(seed, index as u64)).collect();
    let mut im = vec![0.0; LENGTH];
    fft.forward(&mut re, &mut im);
    for bin in 0..LENGTH {
        let folded = bin.min(LENGTH - bin);
        let frequency = (folded.max(1) as f64) * SAMPLE_RATE as f64 / LENGTH as f64;
        let gain = 10f64.powf(decibels(frequency) / 20.0);
        re[bin] *= gain;
        im[bin] *= gain;
    }
    fft.inverse(&mut re, &mut im);
    re
}

pub fn builtin(index: usize) -> ReferenceProfile {
    let design = &DESIGNS[index];
    let fft = Fft::new(LENGTH);
    let mid = shaped(&fft, 1 + index as u64 * 2, |frequency| design.mid_db(frequency));
    let side = shaped(&fft, 2 + index as u64 * 2, |frequency| design.side_db(frequency));
    let rms = (mid.iter().map(|value| value * value).sum::<f64>() / LENGTH as f64).sqrt();
    let scale = 10f64.powf(design.rms / 20.0) / rms;
    let left: Vec<f64> = mid.iter().zip(&side).map(|(mid, side)| (mid + side) * scale).collect();
    let right: Vec<f64> = mid.iter().zip(&side).map(|(mid, side)| (mid - side) * scale).collect();
    analyse_reference(&left, &right).expect("built-in profiles are long enough")
}
