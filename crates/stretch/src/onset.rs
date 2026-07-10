//! Spectral-flux onset detection with adaptive peak picking, replacing the RMS-derivative detector:
//! log-compressed half-wave-rectified flux (soft tonal onsets register), a local-median threshold
//! (one constant no longer fits both a quiet pad and a loud drum loop), minimum separation, and a
//! waveform-domain valley refinement so markers sit at attack starts with sub-hop accuracy.
//! All constants are DRAFT values for the lab harness to sweep.

use alloc::vec::Vec;
use crate::stft::Stft;

#[derive(Clone, Copy, Debug)]
pub struct OnsetConfig {
    pub fft_size: usize,
    pub hop: usize,
    /// Log compression: C(m) = ln(1 + gamma * m).
    pub log_gamma: f32,
    /// Local median window (each side), seconds.
    pub median_window_seconds: f64,
    pub median_alpha: f32,
    /// Absolute floor as a fraction of the global flux maximum.
    pub delta: f32,
    pub min_separation_seconds: f64
}

impl Default for OnsetConfig {
    fn default() -> Self {
        Self {fft_size: 1024, hop: 128, log_gamma: 100.0, median_window_seconds: 0.35, median_alpha: 1.3, delta: 0.01, min_separation_seconds: 0.120}
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Onset {
    pub seconds: f64,
    /// flux / threshold at the pick — the raw exceedance that seeds the strength descriptor.
    pub exceedance: f32
}

pub fn spectral_flux(frames: &[Vec<f32>], log_gamma: f32) -> Vec<f32> {
    let mut flux = Vec::with_capacity(frames.len());
    flux.push(0.0);
    for window in frames.windows(2) {
        let (previous, current) = (&window[0], &window[1]);
        let mut sum = 0.0f32;
        for bin in 0..current.len() {
            let compressed_now = libm::logf(1.0 + log_gamma * current[bin]);
            let compressed_then = libm::logf(1.0 + log_gamma * previous[bin]);
            let rise = compressed_now - compressed_then;
            if rise > 0.0 {
                sum += rise;
            }
        }
        flux.push(sum);
    }
    flux
}

fn local_median(flux: &[f32], center: usize, half_window: usize, scratch: &mut Vec<f32>) -> f32 {
    let from = center.saturating_sub(half_window);
    let to = (center + half_window + 1).min(flux.len());
    scratch.clear();
    scratch.extend_from_slice(&flux[from..to]);
    scratch.sort_by(|a, b| a.partial_cmp(b).unwrap());
    scratch[scratch.len() / 2]
}

/// Refine a hop-resolution pick to the local short-RMS valley in the waveform, so the marker sits
/// where the attack starts rather than where the flux frame landed.
fn refine_to_valley(mono: &[f32], sample_rate: f32, pick_sample: usize, search_back: usize) -> usize {
    let rms_window = (0.001 * sample_rate as f64) as usize;
    let rms_window = rms_window.max(8);
    let from = pick_sample.saturating_sub(search_back);
    let mut best_position = pick_sample.min(mono.len().saturating_sub(1));
    let mut best_rms = f32::MAX;
    let mut position = best_position;
    while position > from {
        let to = (position + rms_window).min(mono.len());
        let mut sum = 0.0f32;
        for sample in &mono[position..to] {
            sum += sample * sample;
        }
        let rms = libm::sqrtf(sum / rms_window as f32);
        if rms < best_rms {
            best_rms = rms;
            best_position = position;
        }
        position = position.saturating_sub(rms_window / 2);
    }
    best_position
}

/// Detect onsets in `mono`. Returns sorted positions (seconds) with their flux exceedance.
pub fn detect(mono: &[f32], sample_rate: f32, config: &OnsetConfig) -> Vec<Onset> {
    let stft = Stft::new(config.fft_size, config.hop);
    let frames = stft.magnitudes(mono);
    if frames.len() < 4 {
        return Vec::new();
    }
    let flux = spectral_flux(&frames, config.log_gamma);
    let global_max = flux.iter().fold(0.0f32, |max, value| max.max(*value));
    if global_max <= 0.0 {
        return Vec::new();
    }
    let frame_rate = sample_rate as f64 / config.hop as f64;
    let half_window = (config.median_window_seconds * frame_rate) as usize;
    let min_separation = (config.min_separation_seconds * frame_rate) as usize;
    let mut scratch: Vec<f32> = Vec::new();
    let mut picks: Vec<(usize, f32)> = Vec::new();
    for frame in 3..flux.len().saturating_sub(3) {
        let threshold = config.median_alpha * local_median(&flux, frame, half_window, &mut scratch) + config.delta * global_max;
        if flux[frame] <= threshold {
            continue;
        }
        let is_local_max = (frame.saturating_sub(3)..=(frame + 3).min(flux.len() - 1)).all(|other| flux[other] <= flux[frame]);
        if !is_local_max {
            continue;
        }
        if let Some(&(last_frame, last_exceedance)) = picks.last() {
            if frame - last_frame < min_separation {
                if flux[frame] / threshold > last_exceedance {
                    picks.pop();
                    picks.push((frame, flux[frame] / threshold));
                }
                continue;
            }
        }
        picks.push((frame, flux[frame] / threshold));
    }
    let mut onsets: Vec<Onset> = picks.into_iter().map(|(frame, exceedance)| {
        // The flux at frame t compares windows starting at (t-1)*hop and t*hop; the energy rise sits
        // inside the newer window — search back from its center.
        let pick_sample = frame * config.hop + config.fft_size / 4;
        let refined = refine_to_valley(mono, sample_rate, pick_sample.min(mono.len().saturating_sub(1)), config.fft_size / 2);
        Onset {seconds: refined as f64 / sample_rate as f64, exceedance}
    }).collect();
    onsets.sort_by(|a, b| a.seconds.partial_cmp(&b.seconds).unwrap());
    onsets.dedup_by(|next, previous| next.seconds - previous.seconds < 0.010);
    onsets
}
