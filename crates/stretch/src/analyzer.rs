//! The Analyzer: PCM in -> transient markers + per-segment descriptors out. Two entry points keep
//! the storage question open: `analyze()` detects AND describes; `describe()` computes descriptors
//! for externally supplied positions (today's `TransientMarkerBox` data, possibly user-edited).
//! Everything here is bind-time work — allocates freely, never runs on a render path. All constants
//! are DRAFT values for the lab harness to sweep.

use alloc::vec::Vec;
use crate::descriptor::TransientDescriptor;
use crate::onset::{detect, Onset, OnsetConfig};
use crate::stft::Stft;

#[derive(Clone, Copy, Debug)]
pub struct AnalyzerConfig {
    pub onset: OnsetConfig,
    /// Strength knee: exceedance of (1 + knee) maps to strength 1.0.
    pub strength_knee: f32,
    /// YIN search range and gate.
    pub pitch_min_hz: f64,
    pub pitch_max_hz: f64,
    pub yin_threshold: f32,
    pub yin_window: usize,
    /// Skip the attack before pitch analysis.
    pub attack_skip_seconds: f64,
    /// Spectral-flatness pivot: flatness >= pivot reads as harmonicity 0.
    pub flatness_pivot: f32,
    /// Aperiodic segments cannot claim more harmonicity than this.
    pub aperiodic_harmonicity_cap: f32,
    /// Pitch-synchronous loops require at least this harmonicity.
    pub pitch_sync_gate: f32,
    /// Nominal loop length range, chosen by strength (weak -> long).
    pub loop_len_min_seconds: f64,
    pub loop_len_max_seconds: f64,
    pub loop_margin_start_seconds: f64,
    pub loop_margin_end_seconds: f64
}

impl Default for AnalyzerConfig {
    fn default() -> Self {
        Self {
            onset: OnsetConfig::default(),
            strength_knee: 4.0,
            pitch_min_hz: 40.0,
            pitch_max_hz: 2000.0,
            yin_threshold: 0.15,
            yin_window: 4096,
            attack_skip_seconds: 0.010,
            flatness_pivot: 0.5,
            aperiodic_harmonicity_cap: 0.3,
            pitch_sync_gate: 0.5,
            loop_len_min_seconds: 0.080,
            loop_len_max_seconds: 0.250,
            loop_margin_start_seconds: 0.010,
            loop_margin_end_seconds: 0.020
        }
    }
}

pub struct AnalyzedSample {
    pub sample_rate: f32,
    pub num_frames: usize,
    pub markers: Vec<TransientDescriptor>
}

pub struct Analyzer {
    config: AnalyzerConfig
}

impl Default for Analyzer {
    fn default() -> Self {
        Self::new(AnalyzerConfig::default())
    }
}

impl Analyzer {
    pub fn new(config: AnalyzerConfig) -> Self {
        Self {config}
    }

    /// Full pass: detect markers and measure each segment.
    pub fn analyze(&self, left: &[f32], right: &[f32], sample_rate: f32) -> AnalyzedSample {
        let mono = mono_fold(left, right);
        let onsets = detect(&mono, sample_rate, &self.config.onset);
        let markers = self.describe_onsets(&mono, sample_rate, &onsets);
        AnalyzedSample {sample_rate, num_frames: mono.len(), markers}
    }

    /// Descriptor-only pass over externally supplied positions (strength falls back to the crest
    /// proxy because no flux exceedance exists for a hand-placed marker).
    pub fn describe(&self, left: &[f32], right: &[f32], sample_rate: f32, positions: &[f64]) -> Vec<TransientDescriptor> {
        let mono = mono_fold(left, right);
        let onsets: Vec<Onset> = positions.iter().map(|&seconds| Onset {seconds, exceedance: -1.0}).collect();
        self.describe_onsets(&mono, sample_rate, &onsets)
    }

    fn describe_onsets(&self, mono: &[f32], sample_rate: f32, onsets: &[Onset]) -> Vec<TransientDescriptor> {
        let mut markers = Vec::with_capacity(onsets.len());
        for (index, onset) in onsets.iter().enumerate() {
            let segment_start = (onset.seconds * sample_rate as f64) as usize;
            let segment_end = onsets.get(index + 1)
                .map(|next| (next.seconds * sample_rate as f64) as usize)
                .unwrap_or(mono.len())
                .min(mono.len());
            if segment_start >= segment_end {
                markers.push(TransientDescriptor::bare(onset.seconds));
                continue;
            }
            let segment = &mono[segment_start..segment_end];
            let rms = segment_rms(segment);
            let strength = if onset.exceedance >= 0.0 {
                clamp01((onset.exceedance - 1.0) / self.config.strength_knee)
            } else {
                crest_strength(mono, sample_rate, segment_start)
            };
            let period = self.yin_period(mono, sample_rate, segment_start, segment_end);
            let harmonicity = self.harmonicity(segment, sample_rate, period);
            let (loop_start, loop_end) = self.precompute_loop(mono, sample_rate, segment_start as f64, segment_end as f64, strength, period, harmonicity);
            markers.push(TransientDescriptor {
                position: onset.seconds, strength, period, harmonicity, rms, loop_start, loop_end
            });
        }
        markers
    }

    /// YIN-lite: cumulative-mean-normalized difference over a window after the attack; the first
    /// lag under the threshold wins (with parabolic refinement). 0.0 = aperiodic.
    fn yin_period(&self, mono: &[f32], sample_rate: f32, segment_start: usize, segment_end: usize) -> f32 {
        let skip = (self.config.attack_skip_seconds * sample_rate as f64) as usize;
        let from = (segment_start + skip).min(segment_end);
        let available = segment_end - from;
        let lag_max = ((sample_rate as f64 / self.config.pitch_min_hz) as usize).min(available / 2);
        let lag_min = (sample_rate as f64 / self.config.pitch_max_hz) as usize;
        if lag_max <= lag_min + 2 {
            return 0.0;
        }
        let window = self.config.yin_window.min(available - lag_max);
        if window < 64 {
            return 0.0;
        }
        let signal = &mono[from..segment_end];
        let mut difference = alloc::vec![0.0f64; lag_max + 1];
        for lag in 1..=lag_max {
            let mut sum = 0.0f64;
            for index in 0..window {
                let delta = (signal[index] - signal[index + lag]) as f64;
                sum += delta * delta;
            }
            difference[lag] = sum;
        }
        let mut running = 0.0f64;
        let mut cmndf = alloc::vec![1.0f64; lag_max + 1];
        for lag in 1..=lag_max {
            running += difference[lag];
            cmndf[lag] = if running > 0.0 {difference[lag] * lag as f64 / running} else {1.0};
        }
        for lag in lag_min.max(2)..lag_max {
            if cmndf[lag] < self.config.yin_threshold as f64 && cmndf[lag] <= cmndf[lag + 1] {
                let previous = cmndf[lag - 1];
                let here = cmndf[lag];
                let next = cmndf[lag + 1];
                let denominator = previous + next - 2.0 * here;
                let adjust = if denominator.abs() > 1e-12 {0.5 * (previous - next) / denominator} else {0.0};
                return (lag as f64 + adjust.clamp(-0.5, 0.5)) as f32;
            }
        }
        0.0
    }

    /// Tonality from mean spectral flatness over the segment (50 Hz - 8 kHz bins), gated by
    /// aperiodicity: noise never gets tonal treatment.
    fn harmonicity(&self, segment: &[f32], sample_rate: f32, period: f32) -> f32 {
        let stft = Stft::new(1024, 512);
        let frames = stft.magnitudes(segment);
        if frames.is_empty() {
            return 0.0;
        }
        let bin_hz = sample_rate as f64 / 1024.0;
        let bin_from = (50.0 / bin_hz) as usize;
        let bin_to = ((8000.0 / bin_hz) as usize).min(frames[0].len());
        if bin_to <= bin_from + 8 {
            return 0.0;
        }
        let mut flatness_sum = 0.0f64;
        for frame in &frames {
            let mut log_sum = 0.0f64;
            let mut linear_sum = 0.0f64;
            let count = (bin_to - bin_from) as f64;
            for bin in bin_from..bin_to {
                let power = (frame[bin] as f64) * (frame[bin] as f64) + 1e-18;
                log_sum += libm::log(power);
                linear_sum += power;
            }
            flatness_sum += libm::exp(log_sum / count) / (linear_sum / count);
        }
        let flatness = (flatness_sum / frames.len() as f64) as f32;
        let _ = period;
        // Uncapped flatness-based tonality: a polyphonic chord IS tonal even though YIN finds no
        // single period (pitch-sync snapping gates on `period` separately). Noise reads ~0 on its
        // own; the former aperiodic cap gated the fade decision on the wrong signal.
        clamp01(1.0 - flatness / self.config.flatness_pivot)
    }

    /// Precompute a correlation-aligned loop region for tonal material. Weak transients get LONGER
    /// nominal loops. When YIN found a period, the loop length snaps to integer cycles and the
    /// splice search stays within +/- period/2 (monophonic case); when it did not (polyphonic
    /// chords, pads — no single f0 exists), the splice is aligned by a WIDE correlation search
    /// alone, and only accepted when it genuinely correlates. Sentinel (end <= start) when the
    /// segment is too short or the material is not tonal — the runtime falls back to margins.
    fn precompute_loop(&self, mono: &[f32], sample_rate: f32, segment_start: f64, segment_end: f64, strength: f32, period: f32, harmonicity: f32) -> (f64, f64) {
        if harmonicity < self.config.pitch_sync_gate {
            return (0.0, -1.0);
        }
        // Stationarity gate: a short loop near the segment start REPLACES the segment's later
        // content — correct for stationary material, wrong for drifting material (a sweep segment
        // would lose its rising half; the spectral guard catches exactly that). Zero-crossing rate
        // of the first vs last quarter is a cheap dominant-frequency drift probe.
        if zcr_drift(mono, segment_start as usize, segment_end as usize) > 0.15 {
            return (0.0, -1.0);
        }
        let rate = sample_rate as f64;
        let earliest_start = segment_start + self.config.loop_margin_start_seconds * rate;
        let loop_end = segment_end - self.config.loop_margin_end_seconds * rate;
        let nominal_seconds = self.config.loop_len_min_seconds + (1.0 - strength as f64) * (self.config.loop_len_max_seconds - self.config.loop_len_min_seconds);
        let nominal = nominal_seconds * rate;
        // The loop ANCHORS AT THE SEGMENT END: the voice plays the whole segment once (attack and
        // all), then sustains on the settled tail. Anchoring at the start would loop the attack
        // ramp forever (a pad's first 200 ms are its quietest — the level guard caught that).
        if period > 0.0 {
            let period = period as f64;
            let mut cycles = libm::round(nominal.max(period) / period).max(1.0);
            let max_cycles = libm::floor((loop_end - earliest_start) / period);
            if max_cycles < 1.0 {
                return (0.0, -1.0);
            }
            cycles = cycles.min(max_cycles);
            let candidate_start = loop_end - cycles * period;
            let window = ((2.0 * period).min(0.010 * rate).max(32.0)) as usize;
            let (start, _score) = self.best_correlated_start(mono, loop_end, candidate_start, (period / 2.0) as isize, window, earliest_start, loop_end - period);
            return (start, loop_end);
        }
        // Polyphonic/periodless tonal path: wide correlation search around the nominal length.
        let minimum_length = 0.5 * self.config.loop_len_min_seconds * rate;
        if loop_end - earliest_start < minimum_length {
            return (0.0, -1.0);
        }
        let candidate_start = (loop_end - nominal).max(earliest_start);
        let search = (0.020 * rate) as isize;
        let window = (0.010 * rate) as usize;
        let (start, score) = self.best_correlated_start(mono, loop_end, candidate_start, search, window, earliest_start, loop_end - minimum_length);
        if score < 0.5 {
            return (0.0, -1.0);
        }
        (start, loop_end)
    }

    /// Slide the loop start within +/- `search` samples to maximize normalized cross-correlation
    /// with the loop end, so the splice (end -> start jump) lands phase-aligned. Returns
    /// (start, score).
    #[allow(clippy::too_many_arguments)]
    fn best_correlated_start(&self, mono: &[f32], loop_end: f64, candidate_start: f64, search: isize, window: usize, earliest_start: f64, latest_start: f64) -> (f64, f64) {
        let end_index = loop_end as usize;
        if end_index + window >= mono.len() || window < 8 {
            return (candidate_start.max(earliest_start), 0.0);
        }
        let reference = &mono[end_index..end_index + window];
        let reference_energy: f64 = reference.iter().map(|value| (*value as f64) * (*value as f64)).sum();
        let mut best_start = candidate_start.max(earliest_start);
        let mut best_score = f64::MIN;
        for offset in -search..=search {
            let start = candidate_start + offset as f64;
            let start_index = start as usize;
            if start < earliest_start || start > latest_start || start_index + window >= mono.len() {
                continue;
            }
            let candidate = &mono[start_index..start_index + window];
            let mut dot = 0.0f64;
            let mut energy = 0.0f64;
            for index in 0..window {
                dot += reference[index] as f64 * candidate[index] as f64;
                energy += (candidate[index] as f64) * (candidate[index] as f64);
            }
            let score = dot / (libm::sqrt(reference_energy) * libm::sqrt(energy) + 1e-12);
            if score > best_score {
                best_score = score;
                best_start = start;
            }
        }
        if best_score == f64::MIN {
            (candidate_start.max(earliest_start), 0.0)
        } else {
            (best_start, best_score)
        }
    }
}

fn mono_fold(left: &[f32], right: &[f32]) -> Vec<f32> {
    left.iter().zip(right.iter()).map(|(l, r)| 0.5 * (l + r)).collect()
}

fn zero_crossings(segment: &[f32]) -> f64 {
    let mut count = 0usize;
    for window in segment.windows(2) {
        if (window[0] >= 0.0) != (window[1] >= 0.0) {
            count += 1;
        }
    }
    count as f64 / segment.len().max(1) as f64
}

/// Relative dominant-frequency drift across a segment: |zcr(last quarter) - zcr(first quarter)|
/// over their mean. ~0 for stationary tones/pads, large for sweeps.
fn zcr_drift(mono: &[f32], segment_start: usize, segment_end: usize) -> f64 {
    let length = segment_end.saturating_sub(segment_start);
    if length < 1024 {
        return 0.0;
    }
    let quarter = length / 4;
    let first = zero_crossings(&mono[segment_start..segment_start + quarter]);
    let last = zero_crossings(&mono[segment_end - quarter..segment_end]);
    let mean = 0.5 * (first + last);
    if mean < 1e-6 {
        return 0.0;
    }
    (last - first).abs() / mean
}

fn segment_rms(segment: &[f32]) -> f32 {
    if segment.is_empty() {
        return 0.0;
    }
    let sum: f64 = segment.iter().map(|value| (*value as f64) * (*value as f64)).sum();
    libm::sqrtf((sum / segment.len() as f64) as f32)
}

/// Strength proxy for hand-placed markers: SLOPE (how much of the 50 ms level already arrived in
/// the first 5 ms — a hit reaches ~1, a swell ~0) times NOVELTY (how much the level rose over the
/// preceding 50 ms — a marker inside steady material reads ~0). Contrast-over-silence alone would
/// call a slow swell from silence "strong", which is exactly wrong for fade decisions.
fn crest_strength(mono: &[f32], sample_rate: f32, onset_index: usize) -> f32 {
    let short = (0.005 * sample_rate as f64) as usize;
    let long = (0.050 * sample_rate as f64) as usize;
    let peak_in = |from: usize, to: usize| mono[from.min(mono.len())..to.min(mono.len())].iter().fold(0.0f32, |max, value| max.max(value.abs()));
    let peak_short = peak_in(onset_index, onset_index + short);
    let peak_long = peak_in(onset_index, onset_index + long);
    if peak_long < 1e-6 {
        return 0.0;
    }
    let slope = peak_short / peak_long;
    let ambient = segment_rms(&mono[onset_index.saturating_sub(long)..onset_index.max(1)]);
    let novelty = ((peak_long - core::f32::consts::SQRT_2 * ambient) / peak_long).max(0.0);
    clamp01(slope * novelty)
}

fn clamp01(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}
