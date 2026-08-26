//! The spectral tier: a phase vocoder with identity phase locking (Laroche-Dolson), used for
//! material where grain splicing has a measured floor (beating chords, dense texture at mild
//! ratios). Applied PER SEGMENT — each segment starts with fresh analysis phases, which IS the
//! transient reset: attacks live at segment starts and are never phase-mangled. Offline/bind-time
//! use (allocates); the engine architecture caches rendered segments off-thread.

use alloc::vec;
use alloc::vec::Vec;
use crate::fft::Fft;

const WINDOW: usize = 2048;
const HOP_ANALYSIS: usize = 512;

pub struct SpectralStretcher {
    fft: Fft,
    window: Vec<f32>
}

impl Default for SpectralStretcher {
    fn default() -> Self {
        Self::new()
    }
}

impl SpectralStretcher {
    pub fn new() -> Self {
        let window = (0..WINDOW)
            .map(|index| (0.5 - 0.5 * libm::cos(2.0 * core::f64::consts::PI * index as f64 / WINDOW as f64)) as f32)
            .collect();
        Self {fft: Fft::new(WINDOW), window}
    }

    /// Stretch one channel by `ratio` (output_len ~= input_len * ratio). Fresh phases at the start.
    pub fn stretch(&self, input: &[f32], ratio: f64) -> Vec<f32> {
        self.stretch_with_resets(input, ratio, &[])
    }

    /// Single-pass stretch with PHASE RESETS at the given sample positions (transient markers):
    /// one continuous render — no segment joins to beat — while attacks re-anchor to true analysis
    /// phases the moment they occur (the Rubber Band model).
    pub fn stretch_with_resets(&self, input: &[f32], ratio: f64, reset_positions: &[usize]) -> Vec<f32> {
        if input.len() < WINDOW * 2 {
            // Too short for spectral processing: resample-free fallback, repeat-pad by naive copy.
            let out_len = (input.len() as f64 * ratio) as usize;
            let mut out = Vec::with_capacity(out_len);
            for index in 0..out_len {
                let source = (index as f64 / ratio) as usize;
                out.push(input[source.min(input.len() - 1)]);
            }
            return out;
        }
        let hop_synthesis = libm::round(HOP_ANALYSIS as f64 * ratio) as usize;
        let bins = WINDOW / 2;
        let frames = (input.len() - WINDOW) / HOP_ANALYSIS + 1;
        let out_len = (input.len() as f64 * ratio) as usize;
        let mut out = vec![0.0f32; out_len + WINDOW];
        let mut norm = vec![0.0f32; out_len + WINDOW];
        let mut re = vec![0.0f32; WINDOW];
        let mut im = vec![0.0f32; WINDOW];
        let mut prev_phase = vec![0.0f64; bins];
        let mut synth_phase = vec![0.0f64; bins];
        let mut magnitude = vec![0.0f32; bins];
        let mut phase = vec![0.0f64; bins];
        for frame in 0..frames {
            let offset = frame * HOP_ANALYSIS;
            for index in 0..WINDOW {
                re[index] = input[offset + index] * self.window[index];
                im[index] = 0.0;
            }
            self.fft.forward(&mut re, &mut im);
            for bin in 0..bins {
                magnitude[bin] = libm::sqrtf(re[bin] * re[bin] + im[bin] * im[bin]);
                phase[bin] = libm::atan2(im[bin] as f64, re[bin] as f64);
            }
            let hit_reset = reset_positions.iter().any(|&position| {
                position >= offset && position < offset + HOP_ANALYSIS
            });
            if frame == 0 || hit_reset {
                synth_phase.copy_from_slice(&phase);
            } else {
                // Peak-picking for identity phase locking: peaks propagate their own phase by
                // instantaneous frequency; neighbors lock to their peak's rotation so vertical
                // coherence survives (the classic phasiness killer).
                let mut peak_of = vec![0usize; bins];
                let mut current_peak = 0usize;
                for bin in 1..bins - 1 {
                    if magnitude[bin] > magnitude[bin - 1] && magnitude[bin] >= magnitude[bin + 1] {
                        current_peak = bin;
                    }
                    peak_of[bin] = current_peak;
                }
                let two_pi = 2.0 * core::f64::consts::PI;
                let mut peak_rotation = vec![0.0f64; bins];
                for bin in 0..bins {
                    if peak_of[bin] == bin || bin == 0 {
                        let expected = two_pi * bin as f64 * HOP_ANALYSIS as f64 / WINDOW as f64;
                        let mut delta = phase[bin] - prev_phase[bin] - expected;
                        delta -= two_pi * libm::round(delta / two_pi);
                        let instantaneous = (expected + delta) / HOP_ANALYSIS as f64;
                        let advance = instantaneous * hop_synthesis as f64;
                        let new_phase = synth_phase[bin] + advance;
                        peak_rotation[bin] = new_phase - phase[bin];
                        synth_phase[bin] = new_phase;
                    }
                }
                for bin in 0..bins {
                    let peak = peak_of[bin];
                    if peak != bin {
                        synth_phase[bin] = phase[bin] + peak_rotation[peak];
                    }
                }
            }
            prev_phase.copy_from_slice(&phase);
            for bin in 0..bins {
                let (sin, cos) = (libm::sin(synth_phase[bin]), libm::cos(synth_phase[bin]));
                re[bin] = magnitude[bin] * cos as f32;
                im[bin] = magnitude[bin] * sin as f32;
            }
            for bin in bins..WINDOW {
                let mirror = WINDOW - bin;
                re[bin] = re[mirror];
                im[bin] = -im[mirror];
            }
            self.fft.inverse(&mut re, &mut im);
            let out_offset = frame * hop_synthesis;
            for index in 0..WINDOW {
                let target = out_offset + index;
                if target < out.len() {
                    out[target] += re[index] * self.window[index];
                    norm[target] += self.window[index] * self.window[index];
                }
            }
        }
        for index in 0..out.len() {
            if norm[index] > 1e-6 {
                out[index] /= norm[index];
            }
        }
        out.truncate(out_len);
        out
    }
}
