//! Per-case metric assembly. Every metric carries a name, a value, and its better-direction; which
//! metrics apply depends on the corpus class. The judges are judged first: `tests/metrics_selftest.rs`
//! calibrates each one on signals with known answers before any engine is measured.

pub mod envelope;
pub mod goertzel;
pub mod attack;
pub mod modulation;
pub mod spectral;
pub mod annotate;

use crate::corpus::{Class, Entry};
use crate::render::RenderSpec;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    LowerBetter,
    HigherBetter,
    TargetOne
}

#[derive(Clone, Debug)]
pub struct MetricValue {
    pub name: &'static str,
    pub value: f64,
    pub better: Direction
}

fn metric(name: &'static str, value: f64, better: Direction) -> MetricValue {
    MetricValue {name, value, better}
}

/// The loop rate the BASELINE engine is expected to produce for this entry: segments loop over
/// their length minus the fixed margins. Engine-agnostic gating uses the band-peak sweep instead.
pub fn expected_loop_hz(entry: &Entry) -> f64 {
    let period = entry.median_segment_seconds() - 0.030;
    if period > 0.02 { 1.0 / period } else { 0.0 }
}

/// Measure one rendered case. `ratio > 1` enables the loop-modulation family (compression does not
/// loop). Attack metrics need ground-truth onsets and a percussive/tonal class.
pub fn measure_case(entry: &Entry, spec: &RenderSpec, out_left: &[f32], out_right: &[f32]) -> Vec<MetricValue> {
    let engine_rate = crate::render::ENGINE_RATE as f64;
    let mut results = Vec::new();
    let source_mono = envelope::mono(spec.left, spec.right);
    let output_mono = envelope::mono(out_left, out_right);
    let source_fast = envelope::fast_envelope(&source_mono, spec.file_rate);
    let output_fast = envelope::fast_envelope(&output_mono, crate::render::ENGINE_RATE);
    results.push(metric("trailing_silence", spectral::trailing_silence_ratio(&output_fast), Direction::LowerBetter));
    let source_bands = spectral::band_fractions(&source_mono, spec.file_rate as f64);
    let output_bands = spectral::band_fractions(&output_mono, engine_rate);
    results.push(metric("spectral_delta_db", spectral::spectral_delta_db(&source_bands, &output_bands), Direction::LowerBetter));
    if matches!(entry.class, Class::Sustained | Class::Sine | Class::Sweep | Class::Tonal) {
        results.push(metric("level_delta_db", spectral::level_delta_db(envelope::rms(&source_mono), envelope::rms(&output_mono)), Direction::LowerBetter));
    }
    let looping = spec.ratio > 1.01;
    if looping && matches!(entry.class, Class::Sustained | Class::Sine | Class::Sweep | Class::Tonal | Class::Mixed) {
        let smooth = envelope::smooth_envelope(&output_mono, crate::render::ENGINE_RATE);
        if let Some(scores) = modulation::modulation_scores(&smooth, expected_loop_hz(entry)) {
            if scores.expected_db.is_finite() {
                results.push(metric("mod_expected_db", scores.expected_db, Direction::LowerBetter));
            }
            results.push(metric("mod_band_peak_db", scores.band_peak_db, Direction::LowerBetter));
            results.push(metric("mod_acf_peak", scores.acf_peak, Direction::LowerBetter));
        }
    }
    if looping {
        if let (Class::Sine, Some(f0)) = (entry.class, entry.sine_f0) {
            let scores = modulation::sine_scores(&output_mono, engine_rate, f0, expected_loop_hz(entry));
            results.push(metric("sine_sideband_db", scores.sideband_db, Direction::LowerBetter));
            results.push(metric("sine_thd_db", scores.thd_db, Direction::LowerBetter));
        }
    }
    if matches!(entry.class, Class::Percussive | Class::Tonal | Class::Mixed) {
        if let Some(scores) = attack::attack_scores(&source_fast, &output_fast, &entry.transients, spec.ratio) {
            results.push(metric("attack_rise_ratio", scores.rise_ratio, Direction::TargetOne));
            results.push(metric("attack_crest_ratio", scores.crest_ratio, Direction::TargetOne));
            results.push(metric("attack_extra_peaks", scores.extra_peaks, Direction::LowerBetter));
        }
    }
    results
}

/// Distance from ideal for a metric value: 0 = perfect, larger = worse, regardless of direction.
pub fn badness(value: &MetricValue) -> f64 {
    match value.better {
        Direction::LowerBetter => value.value,
        Direction::HigherBetter => -value.value,
        Direction::TargetOne => (value.value - 1.0).abs()
    }
}

/// The mathematically perfect score for each metric (the "ideal" report column).
pub fn ideal_value(name: &str) -> f64 {
    match name {
        "attack_rise_ratio" | "attack_crest_ratio" => 1.0,
        "mod_expected_db" | "mod_band_peak_db" | "sine_sideband_db" | "sine_thd_db" => -120.0,
        _ => 0.0
    }
}
