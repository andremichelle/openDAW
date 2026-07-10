//! Independent second-opinion metrics from audio-analyzer-rs — a completely separate DSP stack
//! (symphonia/rustfft lineage), so its readings cannot share our homebrew metrics' bugs. Values
//! compare the stretched output against the source: `sa_attack_ratio` (HPSS attack sharpness must
//! survive), `sa_flatness_delta` (tonality preserved), `sa_centroid_ratio` (brightness preserved),
//! `sa_lufs_delta_db` (perceptual loudness preserved).

use audio_visualizer_rs::analysis::percussive::{hpss, percussive_features};
use audio_visualizer_rs::analysis::spectral::{spectral_centroid, spectral_flatness, stft};
use audio_visualizer_rs::analysis::temporal::measure_lufs;
use crate::metrics::{Direction, MetricValue};

const N_FFT: usize = 2048;
const HOP: usize = 512;

struct Features {
    attack: f64,
    flatness: f64,
    centroid: f64,
    lufs: f64
}

fn features(mono: &[f32], sample_rate: u32) -> Option<Features> {
    if mono.len() < N_FFT * 4 {
        return None;
    }
    let spectrogram = stft(mono, N_FFT, HOP);
    let hpss_result = hpss(&spectrogram, None);
    let percussive = percussive_features(&hpss_result, sample_rate, HOP);
    let mut attack: Vec<f32> = percussive.attack_sharpness.clone();
    attack.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let top = attack.len().div_ceil(10).max(1);
    let attack_mean = attack[..top].iter().map(|value| *value as f64).sum::<f64>() / top as f64;
    let flatness = spectral_flatness(&spectrogram);
    let flatness_mean = flatness.iter().map(|value| *value as f64).sum::<f64>() / flatness.len().max(1) as f64;
    let centroid = spectral_centroid(&spectrogram);
    let centroid_mean = centroid.iter().map(|value| *value as f64).sum::<f64>() / centroid.len().max(1) as f64;
    let lufs = measure_lufs(mono, sample_rate).integrated as f64;
    Some(Features {attack: attack_mean, flatness: flatness_mean, centroid: centroid_mean, lufs})
}

pub fn second_opinion(source_mono: &[f32], source_rate: f32, output_mono: &[f32], output_rate: f32) -> Vec<MetricValue> {
    let Some(source) = features(source_mono, source_rate as u32) else { return Vec::new() };
    let Some(output) = features(output_mono, output_rate as u32) else { return Vec::new() };
    let mut results = Vec::new();
    if source.attack > 1e-6 {
        results.push(MetricValue {name: "sa_attack_ratio", value: output.attack / source.attack, better: Direction::AtLeastOne});
    }
    results.push(MetricValue {name: "sa_flatness_delta", value: (output.flatness - source.flatness).abs(), better: Direction::LowerBetter});
    if source.centroid > 1e-6 {
        results.push(MetricValue {name: "sa_centroid_ratio", value: output.centroid / source.centroid, better: Direction::TargetOne});
    }
    if source.lufs.is_finite() && output.lufs.is_finite() {
        results.push(MetricValue {name: "sa_lufs_delta_db", value: (output.lufs - source.lufs).abs(), better: Direction::LowerBetter});
    }
    results
}
